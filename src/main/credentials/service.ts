import type {
  ArtifactoryCredential,
  CredentialsStatus,
  GitHubCredential,
  SaveArtifactoryRequest,
} from "../../shared/api"
import type { SecretEntry } from "../devsy/schemas"
import type { Host } from "../requirements/host"
import {
  ARTIFACTORY_URL,
  checkArtifactoryToken,
  TOKEN_SECRET,
  TOKEN_TARGET,
  USER_SECRET,
  USER_TARGET,
  validW3id,
} from "./artifactory"
import {
  checkGitHubAccount,
  findGh,
  GIT_HOST,
  type GitHubSignIn,
  ghSignedIn,
} from "./github"

/** What we need from Devsy's secret store (DevsyClient). */
export interface SecretStore {
  listSecrets(): Promise<SecretEntry[]>
  getSecret(name: string): Promise<string>
  setSecret(name: string, value: string): Promise<void>
  deleteSecret(name: string): Promise<void>
}

export interface CredentialServiceDeps {
  host: Host
  secrets: SecretStore
  signIn: GitHubSignIn
  onChange(status: CredentialsStatus): void
  fetch?: typeof fetch
  log?(entry: string): void
}

/**
 * Settings › Credentials: the GitHub CLI sign-in and the Artifactory token,
 * their status, and the `--secret` flags that bring the token into
 * environments. Values never leave the main process except into Devsy.
 */
export class CredentialService {
  private github: GitHubCredential = {
    host: GIT_HOST,
    state: "unknown",
    detail: "Not checked yet.",
  }
  private artifactory: ArtifactoryCredential = {
    url: ARTIFACTORY_URL,
    state: "unknown",
    detail: "Not checked yet.",
  }
  private checking: Promise<CredentialsStatus> | null = null
  private checked = false

  constructor(private readonly deps: CredentialServiceDeps) {}

  current(): CredentialsStatus {
    const pending = this.deps.signIn.pending
    const github: GitHubCredential = { ...this.github }
    if (this.deps.signIn.active) github.signIn = pending ? { ...pending } : {}
    return { github, artifactory: { ...this.artifactory } }
  }

  /** The last result; the first call runs the checks. */
  async get(): Promise<CredentialsStatus> {
    if (!this.checked) return this.check()
    return this.current()
  }

  /** Runs both checks; concurrent callers share one run. */
  check(): Promise<CredentialsStatus> {
    this.checking ??= Promise.all([this.checkGitHub(), this.checkArtifactory()])
      .then(() => {
        this.checked = true
        return this.current()
      })
      .finally(() => {
        this.checking = null
      })
    return this.checking
  }

  /**
   * Called by GitHubSignIn when the sign-in starts, shows its code or ends
   * (from here or from the "This computer" fix); an ended one is checked.
   */
  signInChanged(): void {
    if (this.deps.signIn.active) this.emit()
    else void this.checkGitHub()
  }

  /** Resolves when the sign-in ended; its result arrives as a change. */
  signInGitHub(): Promise<void> {
    return this.deps.signIn.run()
  }

  cancelGitHubSignIn(): void {
    this.deps.signIn.cancel()
  }

  async saveArtifactory(
    req: SaveArtifactoryRequest,
  ): Promise<CredentialsStatus> {
    const user = req.user.trim()
    const token = req.token.trim()
    if (!validW3id(user))
      throw new Error("Enter your w3id, the IBM email address you log in with.")
    if (/\s/.test(token))
      throw new Error(
        "The token contains spaces. Copy it again from Artifactory.",
      )
    if (!token && this.artifactory.state === "missing")
      throw new Error("Paste the token you created on the Artifactory page.")
    if (token) await this.deps.secrets.setSecret(TOKEN_SECRET, token)
    await this.deps.secrets.setSecret(USER_SECRET, user)
    this.deps.log?.("credentials: Artifactory token saved")
    await this.checkArtifactory()
    return this.current()
  }

  async removeArtifactory(): Promise<CredentialsStatus> {
    const stored = new Set(
      (await this.deps.secrets.listSecrets()).map((e) => e.name),
    )
    for (const name of [TOKEN_SECRET, USER_SECRET])
      if (stored.has(name)) await this.deps.secrets.deleteSecret(name)
    this.deps.log?.("credentials: Artifactory token removed")
    await this.checkArtifactory()
    return this.current()
  }

  /**
   * `--secret` specs for `devsy workspace up`: the stored w3id and token,
   * mounted at /run/secrets/IBM_USER and /run/secrets/ARTIFACTORY_TOKEN.
   * Never fails an `up`: without a readable store there are no flags.
   */
  async upSecretFlags(): Promise<string[]> {
    let entries: SecretEntry[]
    try {
      entries = await this.deps.secrets.listSecrets()
    } catch (error) {
      this.deps.log?.(
        `credentials: secret store unavailable, starting without secrets: ${(error as Error).message}`,
      )
      return []
    }
    const available = new Set(
      entries.filter((e) => e.availability === "available").map((e) => e.name),
    )
    const flags: string[] = []
    if (available.has(USER_SECRET))
      flags.push(`${USER_SECRET},type=mount,target=${USER_TARGET}`)
    if (available.has(TOKEN_SECRET))
      flags.push(`${TOKEN_SECRET},type=mount,target=${TOKEN_TARGET}`)
    return flags
  }

  // -------------------------------------------------------------------------

  private async checkGitHub(): Promise<void> {
    const { host } = this.deps
    this.github = await githubStatus(host)
    this.emit()
  }

  private async checkArtifactory(): Promise<void> {
    this.artifactory = await this.artifactoryStatus()
    this.emit()
  }

  private async artifactoryStatus(): Promise<ArtifactoryCredential> {
    const base = { url: ARTIFACTORY_URL }
    const { secrets } = this.deps
    let entries: SecretEntry[]
    try {
      entries = await secrets.listSecrets()
    } catch (error) {
      return {
        ...base,
        state: "unknown",
        detail: `Could not read Devsy's secret store: ${(error as Error).message}`,
      }
    }
    const entry = (name: string) => entries.find((e) => e.name === name)
    const userEntry = entry(USER_SECRET)
    const user =
      userEntry?.availability === "available"
        ? await secrets.getSecret(USER_SECRET).catch(() => undefined)
        : undefined
    const withUser = user ? { ...base, user } : base
    const tokenEntry = entry(TOKEN_SECRET)
    if (!tokenEntry)
      return { ...withUser, state: "missing", detail: "No token stored." }
    if (tokenEntry.availability !== "available")
      return {
        ...withUser,
        state: "unknown",
        detail: `The token is stored, but the secret store is ${tokenEntry.availability.replace(/_/g, " ")}.`,
      }
    let token: string
    try {
      token = await secrets.getSecret(TOKEN_SECRET)
    } catch (error) {
      return {
        ...withUser,
        state: "unknown",
        detail: `Could not read the stored token: ${(error as Error).message}`,
      }
    }
    const result = await checkArtifactoryToken(token, this.deps.fetch)
    switch (result.kind) {
      case "ok":
        return {
          ...withUser,
          state: "ok",
          detail: "Artifactory accepts the token.",
        }
      case "invalid":
        return {
          ...withUser,
          state: "invalid",
          detail: `Artifactory rejects the stored token (HTTP ${result.status}). Create a new one and save it here.`,
        }
      case "unknown":
        return { ...withUser, state: "unknown", detail: result.detail }
    }
  }

  private emit(): void {
    this.deps.onChange(this.current())
  }
}

async function githubStatus(host: Host): Promise<GitHubCredential> {
  const base = { host: GIT_HOST }
  const gh = await findGh(host)
  if (!gh)
    return {
      ...base,
      state: "no-cli",
      detail:
        "The GitHub CLI is not installed. Install it under This computer.",
    }
  if (!(await ghSignedIn(host)))
    return { ...base, state: "signed-out", detail: "Not signed in." }
  const check = await checkGitHubAccount(host, gh)
  switch (check.kind) {
    case "ok": {
      const { login, name } = check.account
      return {
        ...base,
        state: "ok",
        detail: `Signed in as ${login}${name ? ` (${name})` : ""}.`,
        account: check.account,
        scopes: check.scopes,
      }
    }
    case "signed-out":
      return { ...base, state: "signed-out", detail: "Not signed in." }
    case "invalid":
      return { ...base, state: "invalid", detail: check.detail }
    case "unreachable":
      return { ...base, state: "unknown", detail: check.detail }
  }
}

import type {
  ArtifactoryCredential,
  CredentialsStatus,
  GitHubCredential,
  IbmCloudCredential,
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
import { findIcrHelper, ICR_REGISTRY, type IcrGet, icrGet } from "./ibmcloud"

/** Results older than this are checked again when the pane asks for them. */
export const STALE_AFTER_MS = 10 * 60_000

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
  /** Our bin dir (docker-credential-icr may be there, see credential-helper.ts). */
  binDir: string
  onChange(status: CredentialsStatus): void
  fetch?: typeof fetch
  log?(entry: string): void
  now?(): number
}

/**
 * Settings › Credentials: the GitHub CLI sign-in, the Artifactory token and
 * the IBM Cloud login of docker-credential-icr, their status, and the
 * `--secret` flags that bring the token into environments. Values never
 * leave the main process except into Devsy.
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
  private ibmCloud: IbmCloudCredential = {
    registry: ICR_REGISTRY,
    state: "unknown",
    detail: "Not checked yet.",
  }
  private checking: Promise<CredentialsStatus> | null = null
  /** When the last full check finished (ms), 0 before the first. */
  private lastCheck = 0
  private icr: IcrGet | undefined

  constructor(private readonly deps: CredentialServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  current(): CredentialsStatus {
    const pending = this.deps.signIn.pending
    const github: GitHubCredential = { ...this.github }
    if (this.deps.signIn.active) github.signIn = pending ? { ...pending } : {}
    return {
      github,
      artifactory: { ...this.artifactory },
      ibmCloud: { ...this.ibmCloud },
    }
  }

  /** The last result; checks first when never or over STALE_AFTER_MS ago. */
  async get(): Promise<CredentialsStatus> {
    if (this.lastCheck === 0 || this.now() - this.lastCheck > STALE_AFTER_MS)
      return this.check()
    return this.current()
  }

  /**
   * Runs all checks; concurrent callers share one run. The IBM Cloud check
   * may wait for a login in the browser, so it is not awaited: its result
   * arrives as a change.
   */
  check(): Promise<CredentialsStatus> {
    this.checking ??= (async () => {
      void this.checkIbmCloud()
      await Promise.all([this.checkGitHub(), this.checkArtifactory()])
      this.lastCheck = this.now()
      return this.current()
    })().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** Stops waiting for the IBM Cloud login (the helper is stopped). */
  cancelIbmCloudSignIn(): void {
    this.icr?.cancel()
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

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private async checkGitHub(): Promise<void> {
    const { host } = this.deps
    this.github = { ...(await githubStatus(host)), checkedAt: this.stamp() }
    this.emit()
  }

  private async checkArtifactory(): Promise<void> {
    this.artifactory = {
      ...(await this.artifactoryStatus()),
      checkedAt: this.stamp(),
    }
    this.emit()
  }

  /**
   * Asks docker-credential-icr for an icr.io token, as Docker does: it
   * answers from its store, refreshes, or opens the IBM Cloud login.
   */
  private async checkIbmCloud(): Promise<void> {
    if (this.icr) return
    const base = { registry: ICR_REGISTRY }
    const helper = await findIcrHelper(this.deps.host, this.deps.binDir)
    if (!helper) {
      this.ibmCloud = {
        ...base,
        state: "no-helper",
        detail:
          "docker-credential-icr is not installed. Install it under This computer.",
        checkedAt: this.stamp(),
      }
      this.emit()
      return
    }
    const run = icrGet(this.deps.host, helper)
    this.icr = run
    // A stored or refreshed token answers within seconds; after that the
    // helper waits for the login in the browser.
    const waiting = setTimeout(() => {
      this.ibmCloud = { ...this.ibmCloud, signingIn: true }
      this.emit()
    }, 3_000)
    const result = await run.done
    clearTimeout(waiting)
    this.icr = undefined
    switch (result.kind) {
      case "ok": {
        const who = result.email ?? result.name
        this.ibmCloud = {
          ...base,
          state: "ok",
          detail: who ? `Logged in as ${who}.` : "Logged in.",
          account: {
            ...(result.email ? { email: result.email } : {}),
            ...(result.name ? { name: result.name } : {}),
          },
          checkedAt: this.stamp(),
        }
        break
      }
      case "cancelled":
        this.ibmCloud = {
          ...base,
          state: "signed-out",
          detail: "Not logged in: the login was cancelled.",
          checkedAt: this.stamp(),
        }
        break
      case "failed":
        this.ibmCloud = {
          ...base,
          state: "unknown",
          detail: result.detail,
          checkedAt: this.stamp(),
        }
        break
    }
    this.deps.log?.(`credentials: IBM Cloud ${this.ibmCloud.state}`)
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

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
  validW3id,
} from "./artifactory"
import {
  type ArtifactoryTokens,
  SECRET,
  type TokenState,
} from "./artifactory-tokens"
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

/** How often the Artifactory tokens are checked for renewal while the app runs. */
export const RENEW_INTERVAL_MS = 60 * 60_000

/** Delay of the first renewal check after start (the environment list loads first). */
export const FIRST_RENEW_DELAY_MS = 30_000

export interface DeliveryResult {
  delivered: number
  busy: number
  failed: number
}

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
  /** The Artifactory parent and container token and their files (shared design). */
  tokens: ArtifactoryTokens
  /** Writes renewed secret files into running environments (EnvironmentService.deliverSecrets). */
  deliver?(): Promise<DeliveryResult>
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
  /** The last automatic renewal's error, shown in the pane until one succeeds. */
  private renewalError: string | undefined
  /** Changed files not yet written into every running environment. */
  private pendingDelivery = false

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

  /**
   * Sets Artifactory up with an identity token (or only changes the w3id):
   * creates Silicon Harbor's parent and container token and the files, then
   * delivers them to running environments.
   */
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
    const { tokens } = this.deps
    if (token) {
      await tokens.setup(token, user)
      this.deps.log?.("credentials: Artifactory set up")
    } else {
      if (!(await tokens.state()).configured)
        throw new Error(
          "Paste the identity token you created on the Artifactory page.",
        )
      await this.deps.secrets.setSecret(SECRET.user, user)
      await tokens.renew()
    }
    this.renewalError = undefined
    this.pendingDelivery = true
    await this.deliver()
    await this.checkArtifactory()
    return this.current()
  }

  /** Revokes Silicon Harbor's tokens and hands /run/secrets back to the container scripts. */
  async removeArtifactory(): Promise<CredentialsStatus> {
    await this.deps.tokens.remove()
    this.deps.log?.("credentials: Artifactory removed")
    this.renewalError = undefined
    this.pendingDelivery = true
    await this.deliver()
    await this.checkArtifactory()
    return this.current()
  }

  /** "Renew now": a new container token, delivered to running environments. */
  async renewArtifactory(): Promise<CredentialsStatus> {
    await this.renewNow(true)
    await this.checkArtifactory()
    return this.current()
  }

  /**
   * Renews what is due and delivers changed files. Never throws: a failure
   * is shown in the pane and tried again at the next check.
   */
  async renewNow(force = false): Promise<void> {
    try {
      if (await this.deps.tokens.renew({ force })) this.pendingDelivery = true
      this.renewalError = undefined
    } catch (error) {
      this.renewalError = (error as Error).message
      this.deps.log?.(
        `credentials: Artifactory renewal failed: ${this.renewalError}`,
      )
    }
    if (this.pendingDelivery) await this.deliver()
  }

  /** Renewal checks while the app runs: shortly after start, then every hour. */
  startSchedule(): () => void {
    const first = setTimeout(() => void this.renewNow(), FIRST_RENEW_DELAY_MS)
    const every = setInterval(() => void this.renewNow(), RENEW_INTERVAL_MS)
    first.unref?.()
    every.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }

  /** The computer woke up: tokens may have come due while it slept. */
  wake(): void {
    void this.renewNow()
  }

  /**
   * `--secret` specs for `devsy workspace up`: the Artifactory token, the
   * w3id, netrc, JFrog config and marker in /run/secrets. Renews first if
   * due (this `up` then delivers the files). Never fails an `up`: without a
   * readable store there are no flags.
   */
  async upSecretFlags(): Promise<string[]> {
    try {
      await this.deps.tokens.renew()
    } catch (error) {
      this.renewalError = (error as Error).message
      this.deps.log?.(
        `credentials: Artifactory renewal before up failed: ${this.renewalError}`,
      )
    }
    try {
      return await this.deps.tokens.mounts()
    } catch (error) {
      this.deps.log?.(
        `credentials: secret store unavailable, starting without secrets: ${(error as Error).message}`,
      )
      return []
    }
  }

  private async deliver(): Promise<void> {
    if (!this.deps.deliver) {
      this.pendingDelivery = false
      return
    }
    try {
      const result = await this.deps.deliver()
      this.pendingDelivery = result.busy > 0 || result.failed > 0
      this.deps.log?.(
        `credentials: delivered to ${result.delivered} environment(s)${result.busy ? `, ${result.busy} busy` : ""}${result.failed ? `, ${result.failed} failed` : ""}`,
      )
    } catch (error) {
      this.pendingDelivery = true
      this.deps.log?.(
        `credentials: delivery failed: ${(error as Error).message}`,
      )
    }
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
    let tokenState: TokenState
    try {
      tokenState = await this.deps.tokens.state()
    } catch (error) {
      return {
        ...base,
        state: "unknown",
        detail: `Could not read Devsy's secret store: ${(error as Error).message}`,
      }
    }
    const iso = (s?: number) =>
      s === undefined ? undefined : new Date(s * 1000).toISOString()
    const tokenExpiresAt = iso(tokenState.tokenExpiresAt)
    const parentExpiresAt = iso(tokenState.parentExpiresAt)
    const known = {
      ...base,
      ...(tokenState.user ? { user: tokenState.user } : {}),
      ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
      ...(parentExpiresAt ? { parentExpiresAt } : {}),
      ...(this.renewalError ? { renewalError: this.renewalError } : {}),
    }
    if (!tokenState.configured)
      return { ...known, state: "missing", detail: "Not set up yet." }
    let token: string
    try {
      token = await this.deps.secrets.getSecret(SECRET.token)
    } catch {
      return {
        ...known,
        state: "unknown",
        detail: "The container token is missing. Renew now to create one.",
      }
    }
    const result = await checkArtifactoryToken(token, this.deps.fetch)
    switch (result.kind) {
      case "ok":
        return {
          ...known,
          state: "ok",
          detail:
            "Artifactory accepts the token. Silicon Harbor renews it while it runs.",
        }
      case "invalid":
        return {
          ...known,
          state: "invalid",
          detail: `Artifactory rejects the container token (HTTP ${result.status}). Renew now, or set up again with a new identity token.`,
        }
      case "unknown":
        return { ...known, state: "unknown", detail: result.detail }
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

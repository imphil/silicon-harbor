import type {
  CredentialsStatus,
  SaveArtifactoryRequest,
  SiliconHarborApi,
} from "$shared/api"
import { attempt } from "./notifications.svelte"

/** Settings › Credentials: the GitHub CLI sign-in and the Artifactory token. */
export class CredentialStore {
  status = $state<CredentialsStatus | null>(null)
  checking = $state(false)
  saving = $state(false)
  renewing = $state(false)
  loadError = $state("")
  private unsubscribe?: () => void

  /** A browser sign-in is waiting (its code may not be known yet). */
  signingIn = $derived(this.status?.github.signIn !== undefined)

  constructor(private readonly api: () => SiliconHarborApi) {}

  /**
   * Subscribes once; every call (each time the pane opens) asks for the
   * status, which the main process checks again when it is over 10 minutes
   * old.
   */
  async init(): Promise<void> {
    this.unsubscribe ??= this.api().onCredentialsChanged((status) => {
      this.status = status
    })
    await this.load(() => this.api().getCredentials())
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  check(): Promise<void> {
    return this.load(() => this.api().checkCredentials())
  }

  private async load(fn: () => Promise<CredentialsStatus>): Promise<void> {
    this.checking = true
    try {
      this.status = await fn()
      this.loadError = ""
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.checking = false
    }
  }

  signInGitHub() {
    return attempt("Could not sign in to GitHub", () =>
      this.api().signInGitHub(),
    )
  }

  cancelIbmCloudSignIn() {
    return attempt("Could not stop the IBM Cloud login", () =>
      this.api().cancelIbmCloudSignIn(),
    )
  }

  cancelGitHubSignIn() {
    return attempt("Could not cancel the sign-in", () =>
      this.api().cancelGitHubSignIn(),
    )
  }

  /** True when saved (errors are shown as a notification). */
  async saveArtifactory(req: SaveArtifactoryRequest): Promise<boolean> {
    this.saving = true
    try {
      const status = await attempt("Could not save the token", () =>
        this.api().saveArtifactoryToken(req),
      )
      if (status) this.status = status
      return status !== undefined
    } finally {
      this.saving = false
    }
  }

  async removeArtifactory(): Promise<void> {
    const status = await attempt("Could not remove the token", () =>
      this.api().removeArtifactoryToken(),
    )
    if (status) this.status = status
  }

  /** "Renew now": a new container token, delivered to running environments. */
  async renewArtifactory(): Promise<void> {
    this.renewing = true
    try {
      const status = await attempt("Could not renew the token", () =>
        this.api().renewArtifactoryToken(),
      )
      if (status) this.status = status
    } finally {
      this.renewing = false
    }
  }
}

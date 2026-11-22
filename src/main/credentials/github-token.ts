import {
  mountSpec,
  type ProviderStore,
  readSecret,
  type SecretProvider,
} from "./provider"

/** gh's token for github.ibm.com, as `/run/secrets/GITHUB_IBM_COM_TOKEN`. */
export const GITHUB_SECRET = {
  name: "SH_GITHUB_IBM_COM_TOKEN",
  target: "GITHUB_IBM_COM_TOKEN",
} as const

export interface GitHubTokenDeps {
  store: ProviderStore
  /** `gh auth token --hostname github.ibm.com`; undefined when signed out. */
  token(): Promise<string | undefined>
  log?(entry: string): void
}

/**
 * Stores gh's own token for tools in the environment that read a file (a
 * netrc line, scripts). Git and gh themselves get it on demand through
 * Devsy's forwarding. GitHub cannot narrow an OAuth token, so this is gh's
 * token itself; it follows a new sign-in, and is deleted after a sign-out.
 */
export class GitHubToken implements SecretProvider {
  readonly id = "github"

  constructor(private readonly deps: GitHubTokenDeps) {}

  async refresh(): Promise<boolean> {
    const token = await this.deps.token().catch(() => undefined)
    const stored = await readSecret(this.deps.store, GITHUB_SECRET.name)
    if (token === stored) return false
    if (token) {
      await this.deps.store.setSecret(GITHUB_SECRET.name, token)
      this.deps.log?.("github: token stored for environments")
    } else {
      await this.deps.store.deleteSecret(GITHUB_SECRET.name)
      this.deps.log?.("github: signed out; token removed")
    }
    return true
  }

  async secrets(): Promise<string[]> {
    const stored = await readSecret(this.deps.store, GITHUB_SECRET.name)
    return stored ? [mountSpec(GITHUB_SECRET.name, GITHUB_SECRET.target)] : []
  }
}

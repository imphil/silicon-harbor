/**
 * Credential providers (design doc "Three layers"): each one keeps some Devsy
 * secrets current. Devsy mounts them into /run/secrets on every `up`, and the
 * repository's own onSecretsChangedCommand builds whatever files its tools
 * need from them. Providers know nothing about those files.
 */
export interface SecretProvider {
  /** For logs. */
  readonly id: string
  /**
   * Renews what is due and updates the provider's Devsy secrets. Resolves
   * true when a mounted value changed, so running environments need a
   * delivery. `force` renews even what is not due yet.
   */
  refresh(opts?: { force?: boolean }): Promise<boolean>
  /**
   * `--secret NAME,type=mount,target=FILE` specs for `up`, for the secrets
   * that exist. Only names: Devsy reads the values itself.
   */
  secrets(): Promise<string[]>
}

/** What a provider needs from Devsy's secret store (DevsyClient). */
export interface ProviderStore {
  listSecrets(): Promise<Array<{ name: string; availability: string }>>
  getSecret(name: string): Promise<string>
  setSecret(name: string, value: string): Promise<void>
  deleteSecret(name: string): Promise<void>
}

/** A secret's value, or undefined when it is missing or unreadable. */
export async function readSecret(
  store: ProviderStore,
  name: string,
): Promise<string | undefined> {
  const entry = (await store.listSecrets()).find((e) => e.name === name)
  if (entry?.availability !== "available") return undefined
  return (await store.getSecret(name)) || undefined
}

export function mountSpec(secret: string, target: string): string {
  return `${secret},type=mount,target=${target}`
}

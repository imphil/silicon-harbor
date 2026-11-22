import { mountSpec, type ProviderStore, readSecret } from "./provider"

/**
 * /run/secrets/SILICON_HARBOR = `managed`: Silicon Harbor provides the
 * credentials in environments, so the repository's scripts skip their own
 * logins and renewal (design doc, "Three layers"). Owned by the core, not by
 * a provider, and always mounted, after every provider's secrets.
 */
export const MANAGED_SECRET = {
  name: "SH_MANAGED",
  target: "SILICON_HARBOR",
  value: "managed",
} as const

export const MARKER_SPEC = mountSpec(MANAGED_SECRET.name, MANAGED_SECRET.target)

/** Stores the marker unless it is there already. */
export async function ensureMarker(store: ProviderStore): Promise<void> {
  if ((await readSecret(store, MANAGED_SECRET.name)) === MANAGED_SECRET.value)
    return
  await store.setSecret(MANAGED_SECRET.name, MANAGED_SECRET.value)
}

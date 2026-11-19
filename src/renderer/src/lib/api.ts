import type { SiliconHarborApi } from "$shared/api"

declare global {
  interface Window {
    siliconHarbor?: SiliconHarborApi
  }
}

/**
 * The preload bridge. Outside Electron (unit tests, a plain browser) it is
 * missing; callers get a clear error instead of an undefined access.
 */
export function api(): SiliconHarborApi {
  const bridge = window.siliconHarbor
  if (!bridge) throw new Error("Silicon Harbor preload API is not available")
  return bridge
}

/**
 * The typed contract between the main process and the renderer.
 *
 * The preload script exposes exactly this interface as `window.siliconHarbor`.
 * Every channel name lives here so main, preload and renderer cannot drift.
 */

export interface AppInfo {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  /** Absolute path of the bundled Devsy CLI, or null when it is missing. */
  devsyPath: string | null
}

export interface SiliconHarborApi {
  getAppInfo(): Promise<AppInfo>
}

export const IpcChannel = {
  appInfo: "app:info",
} as const

import { posix, win32 } from "node:path"

/**
 * Where Silicon Harbor installs command-line tools (docker-credential-icr).
 *
 * It must be on the user's own PATH, not only on the Devsy CLI's: the
 * credHelpers entry lives in the shared ~/.docker/config.json, so a plain
 * `docker pull icr.io/…` in the user's terminal needs the helper too.
 *
 * - macOS: /usr/local/bin (on the default PATH; writing needs the admin prompt)
 * - Linux: ~/.local/bin (on Fedora's default PATH)
 * - Windows: a per-user folder that we add to the user's PATH
 */
export function userBinDir(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? win32.join(homeDir, "AppData", "Local")
    return win32.join(local, "Programs", "docker-credential-icr")
  }
  if (platform === "darwin") return "/usr/local/bin"
  return posix.join(homeDir, ".local", "bin")
}

/** Whether writing to userBinDir needs administrator rights. */
export function userBinDirNeedsElevation(platform: NodeJS.Platform): boolean {
  return platform === "darwin"
}

export function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts)
}

import { join } from "node:path"

export interface DevsyPathInput {
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
  /** process.resourcesPath of the packaged app. */
  resourcesPath: string
  /** app.getAppPath() — the repository root during development. */
  appPath: string
}

const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "mac",
  win32: "win",
  linux: "linux",
}

/**
 * Where the bundled Devsy CLI lives.
 *
 * scripts/fetch-devsy.mjs writes resources/bin/<os>-<arch>/devsy[.exe];
 * electron-builder copies the matching directory to <resources>/bin in the
 * packaged app. In development the repository copy for the host is used.
 */
export function devsyBinaryPath(input: DevsyPathInput): string {
  const name = input.platform === "win32" ? "devsy.exe" : "devsy"
  if (input.isPackaged) return join(input.resourcesPath, "bin", name)
  const target = `${BUILDER_OS[input.platform] ?? input.platform}-${input.arch}`
  return join(input.appPath, "resources", "bin", target, name)
}

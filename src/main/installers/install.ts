import { join } from "node:path"
import type { Host, RunResult } from "../requirements/host"
import type { Asset } from "./manifest"

/**
 * Runs a downloaded, checksum-verified installer. Every privileged step goes
 * through Host.runElevated, i.e. the normal OS password/UAC prompt.
 */

export class InstallError extends Error {}

function check(result: RunResult, what: string): void {
  if (result.code === 0) return
  const output = `${result.stderr}\n${result.stdout}`.trim()
  // osascript: -128 = user cancelled the password prompt.
  if (
    /User canceled|-128|cancelled by the user|operation was canceled/i.test(
      output,
    )
  ) {
    throw new InstallError(`${what} was cancelled.`)
  }
  // pkexec: 126 = dismissed, 127 = not authorized.
  if (result.code === 126 || result.code === 127) {
    throw new InstallError(
      `${what} needs administrator rights, which were not granted.`,
    )
  }
  // Windows: 1223 = UAC prompt declined.
  if (result.code === 1223 || /canceled by the user/i.test(output)) {
    throw new InstallError(`${what} was cancelled.`)
  }
  throw new InstallError(
    `${what} failed${result.code === null ? "" : ` (exit code ${result.code})`}${output ? `: ${output.split("\n").slice(-3).join(" ")}` : ""}`,
  )
}

export interface InstallInput {
  host: Host
  asset: Asset
  /** The verified installer file. */
  file: string
  /** Display name for messages, e.g. "Rancher Desktop". */
  name: string
  /** binary kind: where to install it. */
  binaryDest?: string
}

export async function runInstaller(input: InstallInput): Promise<void> {
  const { host, asset, file, name } = input
  switch (asset.kind) {
    case "pkg": {
      check(
        await host.runElevated("/usr/sbin/installer", [
          "-pkg",
          file,
          "-target",
          "/",
        ]),
        `Installing ${name}`,
      )
      return
    }
    case "dmg": {
      if (!asset.appName) throw new InstallError(`${name}: missing app name`)
      const mountPoint = await host.tempDir("sh-dmg-")
      check(
        await host.run("/usr/bin/hdiutil", [
          "attach",
          file,
          "-nobrowse",
          "-readonly",
          "-noautoopen",
          "-mountpoint",
          mountPoint,
        ]),
        `Opening the ${name} disk image`,
      )
      try {
        const src = join(mountPoint, asset.appName)
        const dest = join("/Applications", asset.appName)
        // Admin users can usually write /Applications directly; fall back to
        // the password prompt when they cannot.
        const plain = await host.run("/usr/bin/ditto", [src, dest], {
          timeoutMs: 15 * 60_000,
        })
        if (plain.code !== 0) {
          check(
            await host.runElevated("/usr/bin/ditto", [src, dest]),
            `Copying ${name} to Applications`,
          )
        }
      } finally {
        await host.run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"])
        await host.remove(mountPoint)
      }
      return
    }
    case "msi": {
      check(
        await host.runElevated("msiexec.exe", [
          "/i",
          file,
          "/qn",
          "/norestart",
        ]),
        `Installing ${name}`,
      )
      return
    }
    case "inno": {
      check(
        await host.runElevated(file, [
          "/VERYSILENT",
          "/NORESTART",
          "/NOCANCEL",
          "/SP-",
          "/SUPPRESSMSGBOXES",
        ]),
        `Installing ${name}`,
      )
      return
    }
    case "binary": {
      if (!input.binaryDest)
        throw new InstallError(`${name}: missing destination`)
      await host.copyFile(file, input.binaryDest)
      await host.makeExecutable(input.binaryDest)
      return
    }
  }
}

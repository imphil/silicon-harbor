import type { RequirementStatus } from "../../shared/api"
import { firstVersion, type Requirement } from "./types"

/**
 * WSL 2 (Windows). Rancher Desktop runs its engine in WSL; WSLg shows
 * graphical tools from environments. `wsl.exe` prints UTF-16LE (decoded by
 * Host.run).
 */

type WslState =
  | { kind: "ok"; version: string }
  | { kind: "old"; version?: string }
  | { kind: "missing" }

export function parseWslVersion(output: string): string | undefined {
  // "WSL version: 2.6.1.0" (localized label on non-English systems; take the first version-like token)
  const labelled = /WSL[^:\n]*:\s*(\d+\.\d+(?:\.\d+)*)/i.exec(output)?.[1]
  return labelled ?? firstVersion(output)
}

async function diagnose(
  run: (args: string[]) => ReturnType<import("./host").Host["run"]>,
): Promise<WslState> {
  const version = await run(["--version"])
  if (version.code === 0) {
    const v = parseWslVersion(version.stdout)
    if (v && Number(v.split(".")[0]) >= 2)
      return { kind: "ok", version: v.split(".").slice(0, 3).join(".") }
    return { kind: "old", version: v }
  }
  // The in-box WSL (no --version) still answers --status.
  const status = await run(["--status"])
  return status.code === 0 ? { kind: "old" } : { kind: "missing" }
}

export const wsl: Requirement = {
  id: "wsl",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnose((args) => ctx.host.run("wsl.exe", args))
    const base = { id: "wsl" as const, title: "WSL 2" }
    if (state.kind === "ok") {
      ctx.resolvePending()
      return {
        ...base,
        state: "ok",
        version: state.version,
        detail: "WSLg shows graphical tools from your environments.",
      }
    }
    if (ctx.pending === "reboot") {
      return {
        ...base,
        state: "warn",
        detail: "Installed. Restart the computer once to finish.",
      }
    }
    if (state.kind === "old") {
      return {
        ...base,
        state: "warn",
        version: state.version,
        detail:
          "An old version of WSL is installed. Rancher Desktop needs WSL 2.",
        fix: { label: "Update" },
      }
    }
    return {
      ...base,
      state: "missing",
      detail:
        "Not installed. Rancher Desktop needs it to run your environments.",
      fix: { label: "Install", needsReboot: true },
    }
  },

  async fix(ctx) {
    const state = await diagnose((args) => ctx.host.run("wsl.exe", args))
    if (state.kind === "ok") return undefined
    ctx.progress("Setting up WSL… Confirm the Windows prompt.")
    const args =
      state.kind === "old" ? ["--update"] : ["--install", "--no-distribution"]
    const res = await ctx.host.runElevated("wsl.exe", args)
    if (res.code !== 0) {
      throw new Error(
        res.code === 1223
          ? "The Windows prompt was declined."
          : `Setting up WSL failed (exit code ${res.code ?? "unknown"}).`,
      )
    }
    return state.kind === "missing" ? { needsReboot: true } : undefined
  },
}

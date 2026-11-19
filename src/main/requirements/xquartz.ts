import type { RequirementStatus } from "../../shared/api"
import { firstVersion, type Requirement } from "./types"

/**
 * XQuartz (macOS). Devsy forwards X11 (`ForwardX11 yes` in the SSH config),
 * so graphical tools in environments need an X server on the Mac.
 */

const APP_PATHS = [
  "/Applications/Utilities/XQuartz.app",
  "/Applications/XQuartz.app",
]

export const xquartz: Requirement = {
  id: "xquartz",

  async check(ctx): Promise<RequirementStatus> {
    const base = { id: "xquartz" as const, title: "XQuartz" }
    let app: string | undefined
    for (const path of APP_PATHS) {
      if (await ctx.host.exists(path)) {
        app = path
        break
      }
    }
    if (!app) {
      return {
        ...base,
        state: "missing",
        detail:
          "Not installed. Graphical tools in your environments will not open.",
        fix: { label: "Install", needsRelogin: true },
      }
    }
    const res = await ctx.host.run("/usr/bin/defaults", [
      "read",
      `${app}/Contents/Info`,
      "CFBundleShortVersionString",
    ])
    const version = res.code === 0 ? firstVersion(res.stdout) : undefined
    // XQuartz becomes the session's DISPLAY only after logging in again.
    // Nothing else is needed from Silicon Harbor, so it does not count as an
    // issue (first-run setup can continue); the detail tells what is left.
    if (ctx.pending === "relogin") {
      if (!ctx.host.env.DISPLAY) {
        return {
          ...base,
          state: "ok",
          version,
          detail: "Installed. Log out and back in once to finish.",
        }
      }
      ctx.resolvePending()
    }
    return {
      ...base,
      state: "ok",
      version,
      detail: "Shows graphical tools from your environments.",
    }
  },

  async fix(ctx) {
    await ctx.install("xquartz")
    return { needsRelogin: true }
  },
}

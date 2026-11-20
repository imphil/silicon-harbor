import type { RequirementStatus } from "../../shared/api"
import {
  findGh,
  GIT_HOST,
  ghHelperConfigured,
  ghSignedIn,
  httpsRewriteRule,
  setupGit,
} from "../credentials/github"
import { isFedora } from "./container-engine"
import type { Host } from "./host"
import { firstVersion, type Requirement } from "./types"

/**
 * The GitHub sign-in for github.ibm.com, on every platform: Git plus the
 * GitHub CLI (gh) as Git's credential helper for that host. Devsy forwards
 * the gh sign-in into environments, so Git and gh work there too
 * (credentials/github.ts). The account itself is shown in Settings ›
 * Credentials.
 */

const TITLE = "GitHub CLI"
const PURPOSE = `Signs Git and the GitHub CLI in to ${GIT_HOST}.`

type State =
  /** macOS: Apple's command line tools (which contain Git) are missing. */
  | { kind: "no-git-mac" }
  | { kind: "no-git-windows" }
  /** Linux: gh and/or git are missing (installed together with dnf). */
  | { kind: "no-tools-linux"; fedora: boolean; missing: string[] }
  | { kind: "no-gh" }
  | { kind: "not-signed-in"; version?: string }
  | { kind: "not-configured"; version?: string }
  | { kind: "rewritten"; version?: string; rule: string }
  | { kind: "ok"; version?: string }

async function hasGit(host: Host): Promise<boolean> {
  switch (host.platform) {
    case "darwin": {
      // /usr/bin/git is a shim that pops up an install dialog when the
      // command line tools are missing, so ask xcode-select first.
      const tools = await host.run("/usr/bin/xcode-select", ["-p"])
      if (tools.code === 0) return true
      const brewGit = await host.which("git", [
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ])
      return brewGit !== null && brewGit !== "/usr/bin/git"
    }
    case "win32":
      return (
        (await host.run("git", ["--version"], { timeoutMs: 15_000 })).code === 0
      )
    default:
      return (await host.which("git")) !== null
  }
}

async function diagnose(host: Host): Promise<State> {
  const git = await hasGit(host)
  const gh = await findGh(host)
  if (host.platform !== "darwin" && host.platform !== "win32") {
    const missing = [...(gh ? [] : ["gh"]), ...(git ? [] : ["git"])]
    if (missing.length > 0)
      return { kind: "no-tools-linux", fedora: await isFedora(host), missing }
  } else if (!git) {
    return host.platform === "darwin"
      ? { kind: "no-git-mac" }
      : { kind: "no-git-windows" }
  }
  if (!gh) return { kind: "no-gh" }
  const res = await host.run(gh, ["--version"], { timeoutMs: 15_000 })
  const version = res.code === 0 ? firstVersion(res.stdout) : undefined
  if (!(await ghSignedIn(host))) return { kind: "not-signed-in", version }
  if (!(await ghHelperConfigured(host)))
    return { kind: "not-configured", version }
  const rule = await httpsRewriteRule(host)
  if (rule) return { kind: "rewritten", version, rule }
  return { kind: "ok", version }
}

export const gitCredentials: Requirement = {
  id: "git-credentials",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnose(ctx.host)
    const base = { id: "git-credentials" as const, title: TITLE }
    switch (state.kind) {
      case "no-git-mac":
        return {
          ...base,
          state: "missing",
          detail:
            "Git is not installed. It comes with Apple's command line developer tools.",
          fix: { label: "Install Git" },
        }
      case "no-git-windows":
        return {
          ...base,
          state: "missing",
          detail: "Git is not installed. Git for Windows adds it.",
          fix: { label: "Install Git" },
        }
      case "no-tools-linux":
        return state.fedora
          ? {
              ...base,
              state: "missing",
              detail: `Not installed (${state.missing.join(", ")}). ${PURPOSE}`,
              fix: { label: "Install" },
            }
          : {
              ...base,
              state: "missing",
              detail: `Not installed (${state.missing.join(", ")}). Install the GitHub CLI (gh) and Git with your package manager, then check again. ${PURPOSE}`,
            }
      case "no-gh":
        return {
          ...base,
          state: "missing",
          detail: `Not installed. ${PURPOSE}`,
          fix: { label: "Install" },
        }
      case "not-signed-in":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: `Not signed in to ${GIT_HOST} yet.`,
          fix: { label: "Sign in" },
        }
      case "not-configured":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: `Signed in, but Git does not use it for ${GIT_HOST} yet.`,
          fix: { label: "Set up" },
        }
      case "rewritten":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: `Your Git configuration rewrites https://${GIT_HOST} (${state.rule}). Silicon Harbor clones over HTTPS: remove that rule from your Git configuration (~/.gitconfig), then check again.`,
        }
      case "ok":
        return { ...base, state: "ok", version: state.version, detail: PURPOSE }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    let state = await diagnose(host)
    switch (state.kind) {
      case "no-git-mac":
        // Opens Apple's installer dialog; the user finishes it there, then checks again.
        ctx.progress(
          "Follow Apple's installer to add the command line developer tools, then check again.",
        )
        await host.run("/usr/bin/xcode-select", ["--install"])
        return undefined
      case "no-git-windows":
        await ctx.install("git-for-windows")
        break
      case "no-tools-linux": {
        if (!state.fedora)
          throw new Error(
            "Automatic installation is only available on Fedora. Install the GitHub CLI (gh) and Git with your package manager.",
          )
        ctx.progress(
          "Installing the GitHub CLI… You may be asked for your password.",
        )
        const res = await host.runElevated("/bin/sh", [
          "-c",
          "dnf install -y gh git",
        ])
        if (res.code !== 0)
          throw new Error(
            res.code === 126 || res.code === 127
              ? "Administrator rights were not granted."
              : `Installing the GitHub CLI failed: ${(res.stderr || res.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? ""}`,
          )
        break
      }
      case "no-gh":
        await ctx.install("gh")
        break
      default:
        break
    }

    state = await diagnose(host)
    if (state.kind === "no-gh")
      throw new Error(
        "The GitHub CLI was installed, but Silicon Harbor cannot find it yet. Restart Silicon Harbor, then check again.",
      )
    if (state.kind === "not-signed-in") {
      ctx.progress(`Opening ${GIT_HOST} in your browser…`)
      await ctx.signInGitHub(({ code }) =>
        ctx.progress(
          `Enter the code ${code} on the page that opened in your browser (it is on your clipboard).`,
        ),
      )
      return undefined
    }
    if (state.kind === "not-configured") {
      const gh = await findGh(host)
      if (gh) await setupGit(host, gh)
    }
    return undefined
  },
}

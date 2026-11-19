import type { RequirementStatus } from "../../shared/api"
import type { Host } from "./host"
import { firstVersion, type Requirement } from "./types"

/**
 * Git sign-in to github.ibm.com over HTTPS via Git Credential Manager (GCM).
 * macOS and Windows only (PLAN.md §1: Fedora uses the user's existing setup).
 */

async function gcmVersion(host: Host): Promise<string | undefined> {
  const res = await host.run("git", ["credential-manager", "--version"], {
    timeoutMs: 15_000,
  })
  return res.code === 0
    ? (firstVersion(res.stdout) ?? res.stdout.trim())
    : undefined
}

/** GCM configured as a credential helper (any scope: system, global). */
async function gcmConfigured(host: Host): Promise<boolean> {
  const res = await host.run("git", [
    "config",
    "--get-all",
    "credential.helper",
  ])
  return res.code === 0 && /manager/i.test(res.stdout)
}

// ---------------------------------------------------------------------------
// macOS: Git from the Apple command line tools + GCM pkg

type MacState =
  | { kind: "no-git" }
  | { kind: "no-gcm" }
  | { kind: "not-configured"; version: string }
  | { kind: "ok"; version: string }

async function diagnoseMac(host: Host): Promise<MacState> {
  // /usr/bin/git is a shim that pops up an install dialog when the command
  // line tools are missing, so ask xcode-select first.
  const tools = await host.run("/usr/bin/xcode-select", ["-p"])
  const brewGit = await host.which("git", [
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ])
  if (tools.code !== 0 && (!brewGit || brewGit === "/usr/bin/git"))
    return { kind: "no-git" }
  const version = await gcmVersion(host)
  if (!version) return { kind: "no-gcm" }
  return (await gcmConfigured(host))
    ? { kind: "ok", version }
    : { kind: "not-configured", version }
}

export const gitCredentialsMac: Requirement = {
  id: "git-credentials",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnoseMac(ctx.host)
    const base = {
      id: "git-credentials" as const,
      title: "Git Credential Manager",
    }
    switch (state.kind) {
      case "no-git":
        return {
          ...base,
          state: "missing",
          detail:
            "Git is not installed. It comes with Apple's command line developer tools.",
          fix: { label: "Install Git" },
        }
      case "no-gcm":
        return {
          ...base,
          state: "missing",
          detail: "Not installed. Signs in to github.ibm.com over HTTPS.",
          fix: { label: "Install" },
        }
      case "not-configured":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: "Installed, but Git does not use it yet.",
          fix: { label: "Set up" },
        }
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.version,
          detail: "Signs in to github.ibm.com over HTTPS.",
        }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    const state = await diagnoseMac(host)
    if (state.kind === "no-git") {
      // Opens Apple's installer dialog; the user finishes it there, then checks again.
      ctx.progress(
        "Follow Apple's installer to add the command line developer tools, then check again.",
      )
      await host.run("/usr/bin/xcode-select", ["--install"])
      return undefined
    }
    if (state.kind === "no-gcm") await ctx.install("git-credential-manager")
    if (state.kind !== "ok") {
      ctx.progress("Setting up Git Credential Manager…")
      const res = await host.run("git", ["credential-manager", "configure"], {
        timeoutMs: 30_000,
      })
      if (res.code !== 0)
        throw new Error(
          `Could not set up Git Credential Manager: ${(res.stderr || res.stdout).trim()}`,
        )
    }
    return undefined
  },
}

// ---------------------------------------------------------------------------
// Windows: Git for Windows (includes and configures GCM)

type WinState =
  | { kind: "no-git" }
  | { kind: "no-gcm"; gitVersion?: string }
  | { kind: "ok"; gitVersion?: string }

async function diagnoseWindows(host: Host): Promise<WinState> {
  const git = await host.run("git", ["--version"], { timeoutMs: 15_000 })
  if (git.code !== 0) return { kind: "no-git" }
  const gitVersion = firstVersion(git.stdout)
  const gcm = await gcmVersion(host)
  if (!gcm || !(await gcmConfigured(host)))
    return { kind: "no-gcm", gitVersion }
  return { kind: "ok", gitVersion }
}

export const gitCredentialsWindows: Requirement = {
  id: "git-credentials",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnoseWindows(ctx.host)
    const base = { id: "git-credentials" as const, title: "Git for Windows" }
    switch (state.kind) {
      case "no-git":
        return {
          ...base,
          state: "missing",
          detail:
            "Not installed. Includes Git Credential Manager for github.ibm.com.",
          fix: { label: "Install" },
        }
      case "no-gcm":
        return {
          ...base,
          state: "warn",
          version: state.gitVersion,
          detail:
            "Git Credential Manager is missing or not set up. Installing the current Git for Windows adds it.",
          fix: { label: "Update Git for Windows" },
        }
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.gitVersion,
          detail: "Includes Git Credential Manager for github.ibm.com.",
        }
    }
  },

  async fix(ctx) {
    await ctx.install("git-for-windows")
    return undefined
  },
}

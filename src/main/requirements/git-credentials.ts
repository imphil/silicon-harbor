import type { RequirementStatus } from "../../shared/api"
import { isFedora } from "./container-engine"
import type { Host } from "./host"
import { firstVersion, type Requirement } from "./types"

/**
 * Git sign-in to github.ibm.com over HTTPS: Git Credential Manager (GCM) on
 * macOS and Windows, the GitHub CLI (`gh auth setup-git`) on Fedora.
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

// ---------------------------------------------------------------------------
// Linux (Fedora): the GitHub CLI as Git's credential helper for github.ibm.com

/** The Git host Silicon Harbor's repositories live on. */
export const GIT_HOST = "github.ibm.com"

/** The terminal script for an interactive sign-in. */
export const GH_LOGIN_SCRIPT = [
  `gh auth login --hostname ${GIT_HOST} --git-protocol https --web`,
  `&& gh auth setup-git --hostname ${GIT_HOST}`,
  `; status=$?; echo`,
  `; if [ "$status" -eq 0 ]; then echo "Signed in. You can close this window."`,
  `; else echo "Signing in did not finish (exit $status)."; fi`,
  `; printf "Press Enter to close this window. "; read _`,
].join(" ")

const SIGN_IN_WAIT_MS = 10 * 60_000
const SIGN_IN_POLL_MS = 2_000

type LinuxState =
  | { kind: "no-tools"; fedora: boolean; missing: string[] }
  | { kind: "not-signed-in"; version?: string }
  | { kind: "not-configured"; version?: string }
  | { kind: "rewritten"; version?: string; rule: string }
  | { kind: "ok"; version?: string }

function ghConfigDir(host: Host): string {
  if (host.env.GH_CONFIG_DIR) return host.env.GH_CONFIG_DIR
  const xdg = host.env.XDG_CONFIG_HOME || `${host.homeDir}/.config`
  return `${xdg}/gh`
}

/**
 * gh lists every host it is signed in to in hosts.yml (the token itself is
 * in the keyring, or in that file). Reading the file, instead of running
 * `gh auth token`, keeps tokens out of the setup log and works offline.
 */
async function ghSignedIn(host: Host): Promise<boolean> {
  const hosts = await host.readText(`${ghConfigDir(host)}/hosts.yml`)
  const escaped = GIT_HOST.replace(/\./g, "\\.")
  return hosts !== null && new RegExp(`^${escaped}:\\s*$`, "m").test(hosts)
}

/** gh is Git's credential helper for GIT_HOST (host-specific or global). */
async function ghHelperConfigured(host: Host): Promise<boolean> {
  for (const key of [
    `credential.https://${GIT_HOST}.helper`,
    "credential.helper",
  ]) {
    const res = await host.run("git", ["config", "--get-all", key])
    if (
      res.code === 0 &&
      /\bgh(\.exe)?['"]?\s+auth\s+git-credential\b/.test(res.stdout)
    )
      return true
  }
  return false
}

/**
 * A url.<base>.insteadOf rule that rewrites https://GIT_HOST, e.g. to SSH.
 * Silicon Harbor clones over HTTPS, so such a rule breaks the sign-in.
 */
export async function httpsRewriteRule(
  host: Host,
): Promise<string | undefined> {
  const res = await host.run("git", [
    "config",
    "--get-regexp",
    "^url\\..*\\.insteadof$",
  ])
  if (res.code !== 0) return undefined
  for (const line of res.stdout.split(/\r?\n/)) {
    const space = line.indexOf(" ")
    if (space < 0) continue
    const value = line.slice(space + 1).trim()
    if (value.startsWith(`https://${GIT_HOST}`))
      return `${line.slice(0, space)} = ${value}`
  }
  return undefined
}

async function diagnoseLinux(host: Host): Promise<LinuxState> {
  const missing: string[] = []
  if (!(await host.which("gh"))) missing.push("gh")
  if (!(await host.which("git"))) missing.push("git")
  if (missing.length > 0)
    return { kind: "no-tools", fedora: await isFedora(host), missing }
  const res = await host.run("gh", ["--version"], { timeoutMs: 15_000 })
  const version = res.code === 0 ? firstVersion(res.stdout) : undefined
  if (!(await ghSignedIn(host))) return { kind: "not-signed-in", version }
  if (!(await ghHelperConfigured(host)))
    return { kind: "not-configured", version }
  const rule = await httpsRewriteRule(host)
  if (rule) return { kind: "rewritten", version, rule }
  return { kind: "ok", version }
}

async function setupGit(host: Host): Promise<void> {
  const res = await host.run(
    "gh",
    ["auth", "setup-git", "--hostname", GIT_HOST],
    {
      timeoutMs: 30_000,
    },
  )
  if (res.code !== 0)
    throw new Error(
      `Could not set up Git to use the GitHub CLI: ${(res.stderr || res.stdout).trim()}`,
    )
}

export const gitCredentialsLinux: Requirement = {
  id: "git-credentials",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnoseLinux(ctx.host)
    const base = { id: "git-credentials" as const, title: "GitHub CLI" }
    switch (state.kind) {
      case "no-tools":
        return state.fedora
          ? {
              ...base,
              state: "missing",
              detail: `Not installed (${state.missing.join(", ")}). Signs Git in to ${GIT_HOST} over HTTPS.`,
              fix: { label: "Install" },
            }
          : {
              ...base,
              state: "missing",
              detail: `Not installed (${state.missing.join(", ")}). Install the GitHub CLI (gh) with your package manager, then check again. It signs Git in to ${GIT_HOST} over HTTPS.`,
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
          detail: `Your Git configuration rewrites https://${GIT_HOST} (${state.rule}). Silicon Harbor clones over HTTPS: remove that rule from ~/.gitconfig, then check again.`,
        }
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.version,
          detail: `Signs Git in to ${GIT_HOST} over HTTPS.`,
        }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    let state = await diagnoseLinux(host)
    if (state.kind === "no-tools") {
      if (!state.fedora)
        throw new Error(
          "Automatic installation is only available on Fedora. Install the GitHub CLI (gh) with your package manager.",
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
      state = await diagnoseLinux(host)
    }
    if (state.kind === "not-signed-in") {
      ctx.progress(`Sign in to ${GIT_HOST} in the terminal window that opened…`)
      await host.openTerminal(["sh", "-c", GH_LOGIN_SCRIPT])
      for (
        let waited = 0;
        waited < SIGN_IN_WAIT_MS;
        waited += SIGN_IN_POLL_MS
      ) {
        await ctx.sleep(SIGN_IN_POLL_MS)
        if ((await ghSignedIn(host)) && (await ghHelperConfigured(host)))
          return undefined
      }
      // Not finished in time: the re-check shows where it stands.
      return undefined
    }
    if (state.kind === "not-configured") await setupGit(host)
    return undefined
  },
}

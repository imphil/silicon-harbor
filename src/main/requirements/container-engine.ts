import { posix, win32 } from "node:path"
import type { RequirementStatus } from "../../shared/api"
import type { Host } from "./host"
import {
  firstVersion,
  type Requirement,
  type RequirementContext,
} from "./types"

/**
 * Container engine.
 * - macOS / Windows: Rancher Desktop with the dockerd (moby) engine.
 * - Linux: Docker Engine; on Fedora installed from Fedora's `moby-engine`.
 */

const STARTUP_WAIT_MS = 3 * 60_000
const POLL_MS = 3_000

// ---------------------------------------------------------------------------
// Rancher Desktop (macOS, Windows)

const MAC_APP_DIRS = ["/Applications", "~/Applications"]

async function rancherPaths(
  host: Host,
): Promise<{ app?: string; rdctl?: string; binDir?: string }> {
  if (host.platform === "darwin") {
    for (const dir of MAC_APP_DIRS) {
      const app = posix.join(
        dir.replace("~", host.homeDir),
        "Rancher Desktop.app",
      )
      if (await host.exists(app)) {
        const binDir = posix.join(
          app,
          "Contents/Resources/resources/darwin/bin",
        )
        const rdctl =
          (await host.which("rdctl", [posix.join(host.homeDir, ".rd/bin")])) ??
          posix.join(binDir, "rdctl")
        return { app, rdctl, binDir }
      }
    }
    return {}
  }

  // Windows: per-user (default) or per-machine install.
  const roots = [
    host.env.LOCALAPPDATA &&
      win32.join(host.env.LOCALAPPDATA, "Programs", "Rancher Desktop"),
    host.env.ProgramFiles &&
      win32.join(host.env.ProgramFiles, "Rancher Desktop"),
    host.env.PROGRAMFILES &&
      win32.join(host.env.PROGRAMFILES, "Rancher Desktop"),
  ].filter((p): p is string => Boolean(p))
  for (const root of roots) {
    const binDir = win32.join(root, "resources", "resources", "win32", "bin")
    const rdctl = win32.join(binDir, "rdctl.exe")
    if (await host.exists(rdctl)) return { app: root, rdctl, binDir }
  }
  const rdctl = await host.which("rdctl")
  return rdctl ? { rdctl, app: rdctl, binDir: win32.dirname(rdctl) } : {}
}

type RancherState =
  | { kind: "missing" }
  | { kind: "stopped"; rdctl: string; version?: string }
  | { kind: "wrong-engine"; rdctl: string; engine: string; version?: string }
  | { kind: "not-responding"; rdctl: string; version?: string; error: string }
  | { kind: "ok"; version?: string }

async function dockerInfo(
  host: Host,
  extraDirs: string[],
): Promise<{ ok: boolean; version?: string; error: string }> {
  const docker = (await host.which("docker", extraDirs)) ?? "docker"
  const res = await host.run(
    docker,
    ["info", "--format", "{{.ServerVersion}}"],
    { timeoutMs: 20_000 },
  )
  const out = res.stdout.trim()
  if (res.code === 0 && out)
    return { ok: true, version: firstVersion(out) ?? out, error: "" }
  return {
    ok: false,
    error: (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? "",
  }
}

async function rancherVersion(
  host: Host,
  app: string | undefined,
  rdctl: string,
): Promise<string | undefined> {
  if (host.platform === "darwin" && app) {
    const res = await host.run("/usr/bin/defaults", [
      "read",
      posix.join(app, "Contents/Info"),
      "CFBundleShortVersionString",
    ])
    if (res.code === 0) return firstVersion(res.stdout)
  }
  const res = await host.run(rdctl, ["version"])
  return res.code === 0 ? firstVersion(res.stdout) : undefined
}

export async function diagnoseRancher(host: Host): Promise<RancherState> {
  const paths = await rancherPaths(host)
  if (!paths.rdctl) return { kind: "missing" }
  const { rdctl } = paths
  const version = await rancherVersion(host, paths.app, rdctl)

  const settings = await host.run(rdctl, ["list-settings"], {
    timeoutMs: 20_000,
  })
  if (settings.code !== 0) return { kind: "stopped", rdctl, version }
  let engine = "unknown"
  try {
    const parsed = JSON.parse(settings.stdout) as {
      containerEngine?: { name?: string }
    }
    engine = parsed.containerEngine?.name ?? "unknown"
  } catch {
    // unexpected output: treat like not running
    return { kind: "stopped", rdctl, version }
  }
  if (engine !== "moby") return { kind: "wrong-engine", rdctl, engine, version }

  const extra = [
    paths.binDir,
    host.platform === "darwin"
      ? posix.join(host.homeDir, ".rd/bin")
      : undefined,
  ].filter((d): d is string => Boolean(d))
  const info = await dockerInfo(host, extra)
  if (!info.ok)
    return { kind: "not-responding", rdctl, version, error: info.error }
  return { kind: "ok", version }
}

async function waitForDocker(
  ctx: RequirementContext,
  rdctlDir: string | undefined,
): Promise<void> {
  const extra = [
    rdctlDir,
    ctx.host.platform === "darwin"
      ? posix.join(ctx.host.homeDir, ".rd/bin")
      : undefined,
  ].filter((d): d is string => Boolean(d))
  const deadline = STARTUP_WAIT_MS / POLL_MS
  for (let i = 0; i < deadline; i++) {
    if ((await dockerInfo(ctx.host, extra)).ok) return
    await ctx.sleep(POLL_MS)
  }
  // Not fatal: the next check shows "starting" until it is up.
}

const START_ARGS = [
  "start",
  "--container-engine.name=moby",
  "--application.start-in-background",
]

export const rancherDesktop: Requirement = {
  id: "container-engine",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnoseRancher(ctx.host)
    const base = { id: "container-engine" as const, title: "Rancher Desktop" }
    switch (state.kind) {
      case "missing":
        return {
          ...base,
          state: "missing",
          detail: "Not installed. Runs your environments.",
          fix: { label: "Install" },
        }
      case "stopped":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: "Installed, but not running.",
          fix: { label: "Start", automatic: true },
        }
      case "wrong-engine":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: `Uses the wrong engine (${state.engine}). Silicon Harbor needs dockerd.`,
          fix: { label: "Switch to dockerd" },
        }
      case "not-responding":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail:
            "Running, but the engine does not respond yet. It may still be starting.",
          fix: { label: "Restart" },
        }
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.version,
          detail: "Running with dockerd (moby).",
        }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    let state = await diagnoseRancher(host)
    if (state.kind === "missing") {
      await ctx.install("rancher-desktop")
      state = await diagnoseRancher(host)
      if (state.kind === "missing")
        throw new Error("Rancher Desktop was installed but cannot be found.")
    }
    if (state.kind === "ok") return undefined
    const paths = await rancherPaths(host)
    const rdctl = state.rdctl
    if (state.kind === "wrong-engine") {
      ctx.progress("Switching Rancher Desktop to dockerd…")
      const res = await host.run(
        rdctl,
        ["set", "--container-engine.name=moby"],
        { timeoutMs: 120_000 },
      )
      if (res.code !== 0)
        throw new Error(
          `Could not switch the engine: ${(res.stderr || res.stdout).trim()}`,
        )
    } else if (state.kind === "not-responding") {
      ctx.progress("Restarting Rancher Desktop…")
      await host.run(rdctl, ["shutdown"], { timeoutMs: 120_000 })
      const res = await host.run(rdctl, START_ARGS, { timeoutMs: 120_000 })
      if (res.code !== 0)
        throw new Error(
          `Could not start Rancher Desktop: ${(res.stderr || res.stdout).trim()}`,
        )
    } else {
      ctx.progress("Starting Rancher Desktop…")
      const res = await host.run(rdctl, START_ARGS, { timeoutMs: 120_000 })
      if (res.code !== 0)
        throw new Error(
          `Could not start Rancher Desktop: ${(res.stderr || res.stdout).trim()}`,
        )
    }
    ctx.progress(
      "Waiting for the engine to start. The first start can take a few minutes…",
    )
    await waitForDocker(ctx, paths.binDir)
    return undefined
  },
}

// ---------------------------------------------------------------------------
// Docker Engine (Linux; Fedora's moby-engine)

/** Linux user names we pass to usermod (defensive: no shell metacharacters). */
const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i

async function isFedora(host: Host): Promise<boolean> {
  const text = await host.readText("/etc/os-release")
  if (!text) return false
  const id = /^ID="?([^"\n]*)"?/m.exec(text)?.[1] ?? ""
  const like = /^ID_LIKE="?([^"\n]*)"?/m.exec(text)?.[1] ?? ""
  return id === "fedora" || like.split(/\s+/).includes("fedora")
}

type LinuxDockerState =
  | { kind: "ok"; version?: string }
  | { kind: "missing"; fedora: boolean }
  | { kind: "stopped" }
  | { kind: "not-in-group" }
  | { kind: "relogin" }
  | { kind: "not-responding"; error: string }

export async function diagnoseLinuxDocker(
  host: Host,
): Promise<LinuxDockerState> {
  const docker = await host.which("docker")
  if (!docker) return { kind: "missing", fedora: await isFedora(host) }
  const info = await dockerInfo(host, [])
  if (info.ok) return { kind: "ok", version: info.version }

  const active = await host.run("systemctl", ["is-active", "docker"])
  if (active.stdout.trim() !== "active") return { kind: "stopped" }

  // Rootful docker: the socket belongs to the docker group.
  const groups = await host.run("id", ["-nG"])
  if (!groups.stdout.split(/\s+/).includes("docker")) {
    const entry = await host.run("getent", ["group", "docker"])
    const members = entry.stdout.trim().split(":")[3]?.split(",") ?? []
    return members.includes(host.userName)
      ? { kind: "relogin" }
      : { kind: "not-in-group" }
  }
  return { kind: "not-responding", error: info.error }
}

export const linuxDocker: Requirement = {
  id: "container-engine",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnoseLinuxDocker(ctx.host)
    const base = { id: "container-engine" as const, title: "Docker Engine" }
    if (state.kind === "ok") ctx.resolvePending()
    switch (state.kind) {
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.version,
          detail: "Running.",
        }
      case "missing":
        return state.fedora
          ? {
              ...base,
              state: "missing",
              detail: "Not installed. Runs your environments.",
              fix: { label: "Install", needsRelogin: true },
            }
          : {
              ...base,
              state: "missing",
              detail:
                "Not installed. Install Docker Engine with your distribution's package manager.",
            }
      case "stopped":
        return {
          ...base,
          state: "warn",
          detail: "Installed, but not running.",
          fix: { label: "Start" },
        }
      case "not-in-group":
        return {
          ...base,
          state: "warn",
          detail: "Installed, but your user is not in the docker group.",
          fix: { label: "Add me to the group", needsRelogin: true },
        }
      case "relogin":
        return {
          ...base,
          state: "warn",
          detail:
            "Added to the docker group. Log out and back in once to finish.",
        }
      case "not-responding":
        return {
          ...base,
          state: "warn",
          detail: `Installed and running, but it does not respond${state.error ? `: ${state.error}` : "."}`,
        }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    if (!USER_NAME.test(host.userName))
      throw new Error(
        "Unexpected user name; add yourself to the docker group manually.",
      )
    const state = await diagnoseLinuxDocker(host)
    // One elevated shell, so the user sees a single password prompt.
    const steps: string[] = []
    if (state.kind === "missing") {
      if (!state.fedora)
        throw new Error("Automatic installation is only available on Fedora.")
      steps.push("dnf install -y moby-engine")
    }
    if (state.kind === "missing" || state.kind === "stopped")
      steps.push("systemctl enable --now docker")
    if (
      state.kind === "missing" ||
      state.kind === "not-in-group" ||
      state.kind === "stopped"
    ) {
      steps.push(`usermod -aG docker '${host.userName}'`)
    }
    if (steps.length === 0) return undefined
    ctx.progress(
      state.kind === "missing"
        ? "Installing Docker Engine… You may be asked for your password."
        : "Setting up Docker Engine… You may be asked for your password.",
    )
    const res = await host.runElevated("/bin/sh", ["-c", steps.join(" && ")])
    if (res.code !== 0) {
      throw new Error(
        res.code === 126 || res.code === 127
          ? "Administrator rights were not granted."
          : `Setting up Docker Engine failed: ${(res.stderr || res.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? ""}`,
      )
    }
    const groups = await host.run("id", ["-nG"])
    return groups.stdout.split(/\s+/).includes("docker")
      ? undefined
      : { needsRelogin: true }
  },
}

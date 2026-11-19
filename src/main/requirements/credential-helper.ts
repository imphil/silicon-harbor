import type { RequirementStatus } from "../../shared/api"
import { findAsset } from "../installers/manifest"
import {
  dockerConfigPath,
  hasIcrHelper,
  mergeIcrHelper,
  parseDockerConfig,
} from "./docker-config"
import {
  firstVersion,
  type Requirement,
  type RequirementContext,
} from "./types"
import { joinFor, userBinDirNeedsElevation } from "./user-bin"

/**
 * docker-credential-icr: signs image pulls from icr.io in with the user's IBM
 * Cloud login. Needs the binary (on PATH, or in ctx.binDir, which is on both
 * the user's and the Devsy CLI's PATH) and `credHelpers["icr.io"] = "icr"` in
 * the Docker config.
 */

export function helperBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "docker-credential-icr.exe"
    : "docker-credential-icr"
}

async function findHelper(ctx: RequirementContext): Promise<string | null> {
  return ctx.host.which("docker-credential-icr", [ctx.binDir])
}

type State =
  | { kind: "missing"; installable: boolean }
  | { kind: "not-configured"; version?: string }
  | { kind: "config-unreadable"; error: string; version?: string }
  | { kind: "ok"; version?: string }

async function diagnose(ctx: RequirementContext): Promise<State> {
  const { host } = ctx
  const helper = await findHelper(ctx)
  if (!helper) {
    const lookup = findAsset(
      ctx.manifest,
      "docker-credential-icr",
      host.platform,
      host.arch,
    )
    return { kind: "missing", installable: lookup.ok }
  }
  const res = await host.run(helper, ["version"], { timeoutMs: 10_000 })
  const version = res.code === 0 ? firstVersion(res.stdout) : undefined

  const read = parseDockerConfig(
    await host.readText(dockerConfigPath(host.env, host.homeDir)),
  )
  if (!read.ok) return { kind: "config-unreadable", error: read.error, version }
  return hasIcrHelper(read.config)
    ? { kind: "ok", version }
    : { kind: "not-configured", version }
}

/**
 * Installs the helper into ctx.binDir, which is on the user's own PATH (see
 * user-bin.ts). macOS needs the admin prompt for /usr/local/bin, so the
 * download is staged in a temp dir first; Windows adds the folder to the
 * user's PATH.
 */
async function installHelper(ctx: RequirementContext): Promise<void> {
  const { host } = ctx
  const name = helperBinaryName(host.platform)
  const dest = joinFor(host.platform, ctx.binDir, name)

  if (!userBinDirNeedsElevation(host.platform)) {
    await host.mkdirp(ctx.binDir)
    await ctx.install("docker-credential-icr", { binaryDest: dest })
    if (host.platform === "win32") await addToUserPath(ctx, ctx.binDir)
    return
  }

  const staging = await host.tempDir("sh-icr-")
  try {
    const staged = joinFor(host.platform, staging, name)
    await ctx.install("docker-credential-icr", { binaryDest: staged })
    // Paths are ours (temp dir, fixed bin dir); refuse anything that could
    // break out of the single quotes rather than escaping it.
    if ([staged, ctx.binDir, dest].some((p) => p.includes("'")))
      throw new Error("Unexpected character in an install path.")
    ctx.progress(
      "Installing docker-credential-icr… You may be asked for your password.",
    )
    const res = await host.runElevated("/bin/sh", [
      "-c",
      `mkdir -p '${ctx.binDir}' && install -m 0755 '${staged}' '${dest}'`,
    ])
    if (res.code !== 0)
      throw new Error(
        res.code === 126 || res.code === 127
          ? "Administrator rights were not granted."
          : `Installing docker-credential-icr failed: ${lastLine(res.stderr || res.stdout)}`,
      )
  } finally {
    await host.remove(staging)
  }
}

/** Adds dir to the user's (not the machine's) PATH; no elevation needed. */
async function addToUserPath(
  ctx: RequirementContext,
  dir: string,
): Promise<void> {
  const quoted = dir.replaceAll("'", "''")
  const script = [
    `$d = '${quoted}'`,
    `$p = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if (-not (($p -split ';') -contains $d)) {`,
    `  $n = if ($p) { "$p;$d" } else { $d }`,
    `  [Environment]::SetEnvironmentVariable('Path', $n, 'User')`,
    `}`,
  ].join("\n")
  const res = await ctx.host.run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 30_000 },
  )
  if (res.code !== 0)
    throw new Error(
      `docker-credential-icr was installed, but adding it to your PATH failed: ${lastLine(res.stderr || res.stdout)}`,
    )
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).slice(-1)[0] ?? ""
}

export const credentialHelper: Requirement = {
  id: "credential-helper",

  async check(ctx): Promise<RequirementStatus> {
    const state = await diagnose(ctx)
    const base = {
      id: "credential-helper" as const,
      title: "docker-credential-icr",
    }
    switch (state.kind) {
      case "missing":
        return state.installable
          ? {
              ...base,
              state: "missing",
              detail:
                "Not installed. Signs in to icr.io with your IBM Cloud login.",
              fix: { label: "Install" },
            }
          : {
              ...base,
              state: "missing",
              detail:
                "Not installed. Signs in to icr.io with your IBM Cloud login. It cannot be installed automatically yet: put docker-credential-icr on your PATH, then check again.",
            }
      case "not-configured":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: "Installed, but not set up for icr.io yet.",
          fix: { label: "Set up" },
        }
      case "config-unreadable":
        return {
          ...base,
          state: "warn",
          version: state.version,
          detail: `Your Docker configuration file could not be read (${state.error}). Fix or remove ~/.docker/config.json, then check again.`,
        }
      case "ok":
        return {
          ...base,
          state: "ok",
          version: state.version,
          detail: "Signs in to icr.io with your IBM Cloud login.",
        }
    }
  },

  async fix(ctx) {
    const { host } = ctx
    if (!(await findHelper(ctx))) await installHelper(ctx)

    const path = dockerConfigPath(host.env, host.homeDir)
    const text = await host.readText(path)
    const read = parseDockerConfig(text)
    if (!read.ok)
      throw new Error(
        `Your Docker configuration file could not be read (${read.error}); it was left unchanged.`,
      )
    if (hasIcrHelper(read.config)) return undefined

    ctx.progress("Setting up icr.io sign-in…")
    if (text !== null)
      await host.writeTextAtomic(`${path}.silicon-harbor-backup`, text)
    await host.writeTextAtomic(path, mergeIcrHelper(read.config))
    return undefined
  },
}

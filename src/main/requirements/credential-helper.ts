import { join } from "node:path"
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

/**
 * docker-credential-icr: signs image pulls from icr.io in with the user's IBM
 * Cloud login. Needs the binary (on PATH, or in our bin dir which is on the
 * Devsy CLI's PATH) and `credHelpers["icr.io"] = "icr"` in the Docker config.
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
    if (!(await findHelper(ctx))) {
      const dest = join(ctx.binDir, helperBinaryName(host.platform))
      await ctx.install("docker-credential-icr", { binaryDest: dest })
    }

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

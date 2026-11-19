import { join } from "node:path"

/**
 * The Docker client configuration used for image pulls (Devsy runs the docker
 * CLI). Respects DOCKER_CONFIG like the docker CLI does.
 */
export function dockerConfigPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const dir = env.DOCKER_CONFIG?.trim()
  return join(dir || join(homeDir, ".docker"), "config.json")
}

export const ICR_REGISTRY = "icr.io"
export const ICR_HELPER = "icr"

export type ConfigRead =
  | { ok: true; config: Record<string, unknown> | null }
  | { ok: false; error: string }

/** Parses config.json text; null text = no file yet. */
export function parseDockerConfig(text: string | null): ConfigRead {
  if (text === null || text.trim() === "") return { ok: true, config: null }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "not a JSON object" }
    }
    return { ok: true, config: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function hasIcrHelper(config: Record<string, unknown> | null): boolean {
  const helpers = config?.credHelpers
  return (
    !!helpers &&
    typeof helpers === "object" &&
    (helpers as Record<string, unknown>)[ICR_REGISTRY] === ICR_HELPER
  )
}

/**
 * Returns config.json text with credHelpers["icr.io"] = "icr", keeping every
 * other key (credsStore, auths, other helpers, proxies, …) untouched. Docker
 * itself writes tab-indented JSON; we do the same.
 */
export function mergeIcrHelper(config: Record<string, unknown> | null): string {
  const next: Record<string, unknown> = { ...(config ?? {}) }
  const existing = next.credHelpers
  const helpers =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  helpers[ICR_REGISTRY] = ICR_HELPER
  next.credHelpers = helpers
  return `${JSON.stringify(next, null, "\t")}\n`
}

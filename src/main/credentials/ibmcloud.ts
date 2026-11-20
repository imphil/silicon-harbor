import type { Host, StartedProcess } from "../requirements/host"

/**
 * IBM Cloud: the login of docker-credential-icr, which Docker (and so Devsy)
 * asks for icr.io images. Asking the helper ourselves (`get` with the
 * registry on stdin, as Docker does) returns its stored token, refreshes it,
 * or opens the IBM Cloud login in the browser. Doing that from Settings ›
 * Credentials puts the login prompt there instead of in the middle of an
 * image download.
 */

export const ICR_REGISTRY = "icr.io"

/** The login in the browser may take a while; after this we stop waiting. */
export const ICR_LOGIN_TIMEOUT_MS = 10 * 60_000

export function findIcrHelper(
  host: Host,
  binDir: string,
): Promise<string | null> {
  return host.which("docker-credential-icr", [binDir])
}

export type IcrGetResult =
  | { kind: "ok"; email?: string; name?: string }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" }

/** A running `docker-credential-icr get`. */
export interface IcrGet {
  done: Promise<IcrGetResult>
  cancel(): void
}

/**
 * Runs `get` for icr.io. The answer holds the access token: it is read here
 * for the account name and never logged or passed on.
 */
export function icrGet(host: Host, helper: string): IcrGet {
  const stdout: string[] = []
  const stderr: string[] = []
  let cancelled = false
  let timedOut = false
  const process: StartedProcess = host.start(helper, ["get"], {
    input: `${ICR_REGISTRY}\n`,
    onLine: (line, stream) =>
      (stream === "stdout" ? stdout : stderr).push(line),
  })
  const timer = setTimeout(() => {
    timedOut = true
    process.kill()
  }, ICR_LOGIN_TIMEOUT_MS)
  const done = process.done.then((code): IcrGetResult => {
    clearTimeout(timer)
    if (cancelled) return { kind: "cancelled" }
    if (timedOut)
      return {
        kind: "failed",
        detail: "The IBM Cloud login was not finished within 10 minutes.",
      }
    if (code !== 0) {
      const reason = stderr
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1)
      return {
        kind: "failed",
        detail: reason
          ? `docker-credential-icr failed: ${reason}`
          : `docker-credential-icr failed (exit ${code}).`,
      }
    }
    const account = accountFromCredentials(stdout.join("\n"))
    return account
      ? { kind: "ok", ...account }
      : {
          kind: "failed",
          detail: "Unexpected answer from docker-credential-icr.",
        }
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      process.kill()
    },
  }
}

/**
 * The account in a credential helper answer ({"ServerURL", "Username",
 * "Secret"}): the secret is an IBM Cloud IAM access token, a JWT whose
 * payload names the account. Not verified: only shown to the user.
 */
export function accountFromCredentials(
  text: string,
): { email?: string; name?: string } | null {
  let secret: unknown
  try {
    secret = (JSON.parse(text) as { Secret?: unknown }).Secret
  } catch {
    return null
  }
  if (typeof secret !== "string" || !secret) return null
  const payload = secret.split(".")[1]
  if (!payload) return {}
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
    const email = str(claims.email)
    const name = str(claims.name)
    return { ...(email ? { email } : {}), ...(name ? { name } : {}) }
  } catch {
    return {}
  }
}

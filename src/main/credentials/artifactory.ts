/**
 * IBM Artifactory: the user creates an identity token on the Artifactory web
 * page (there is no sign-in flow we could drive) and pastes it into Silicon
 * Harbor once; artifactory-tokens.ts turns it into renewing tokens and the
 * files the environments read in /run/secrets.
 */

export const ARTIFACTORY_URL = "https://eu.artifactory.swg-devops.com/"

/** A file every token for our repositories can read; 200 proves the token works. */
export const ARTIFACTORY_CHECK_URL =
  "https://eu.artifactory.swg-devops.com/artifactory/sys-chipdev-cloud-team-electric-vapor-el8-rpm-local/repodata/repomd.xml"

export type TokenCheck =
  | { kind: "ok" }
  | { kind: "invalid"; status: number }
  | { kind: "unknown"; detail: string }

/** Asks Artifactory whether it accepts the token. */
export async function checkArtifactoryToken(
  token: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<TokenCheck> {
  try {
    const res = await fetchFn(ARTIFACTORY_CHECK_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Only the status matters; don't download the file.
    await res.body?.cancel().catch(() => {})
    if (res.status === 200) return { kind: "ok" }
    if (res.status === 401 || res.status === 403)
      return { kind: "invalid", status: res.status }
    return {
      kind: "unknown",
      detail: `Artifactory answered HTTP ${res.status}.`,
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "no answer within 15 seconds"
        : error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error)
    return {
      kind: "unknown",
      detail: `Could not reach Artifactory (${reason}).`,
    }
  }
}

/** A plausible w3id: an email address. */
export function validW3id(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}

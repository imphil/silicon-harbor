import { randomBytes } from "node:crypto"
import type { Host } from "../requirements/host"

/**
 * A stable id for this installation, used in the descriptions of its
 * Artifactory tokens (`silicon-harbor:<id>:shared`), so each computer cleans
 * up only its own tokens. Not the hostname: people rename computers.
 */
export async function loadComputerId(
  host: Host,
  path: string,
): Promise<string> {
  const existing = (await host.readText(path))?.trim()
  if (existing && /^[0-9a-f]{12}$/.test(existing)) return existing
  const id = randomBytes(6).toString("hex")
  await host.writeTextAtomic(path, `${id}\n`)
  return id
}

import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"

export type FetchLike = (
  url: string,
  init?: { redirect?: "follow"; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}>

export interface DownloadInput {
  url: string
  sha256: string
  /** Directory the file is written to (a fresh temp dir). */
  dir: string
  /** 0–100 when the size is known, otherwise undefined. */
  onProgress?: (percent: number | undefined) => void
  fetch?: FetchLike
  signal?: AbortSignal
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      "The downloaded installer does not match its published checksum, so it was not run.",
    )
  }
}

function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop()
  let decoded = last ?? "installer"
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep it encoded
  }
  const safe = decoded.replace(/[^A-Za-z0-9._-]/g, "_")
  return safe || "installer"
}

/**
 * Downloads an installer over HTTPS, hashing while writing. The file is only
 * returned when its sha256 matches; otherwise it is deleted.
 */
export async function downloadVerified(input: DownloadInput): Promise<string> {
  if (!input.url.startsWith("https://")) {
    throw new Error("Installers are only downloaded over HTTPS")
  }
  const doFetch = input.fetch ?? (fetch as unknown as FetchLike)
  const res = await doFetch(input.url, {
    redirect: "follow",
    signal: input.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status})`)
  }

  const total = Number(res.headers.get("content-length") ?? "") || undefined
  const path = join(input.dir, fileNameOf(input.url))
  const out = createWriteStream(path)
  const hash = createHash("sha256")
  let received = 0
  let lastPercent = -1

  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", resolve))
      }
      const percent = total
        ? Math.min(100, Math.floor((received / total) * 100))
        : undefined
      if (percent !== lastPercent) {
        lastPercent = percent ?? -1
        input.onProgress?.(percent)
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    )
  } catch (error) {
    out.destroy()
    await rm(path, { force: true })
    throw error
  }

  const actual = hash.digest("hex")
  if (actual !== input.sha256.toLowerCase()) {
    await rm(path, { force: true })
    throw new ChecksumMismatchError(input.sha256, actual)
  }
  return path
}

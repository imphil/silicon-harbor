#!/usr/bin/env node
/**
 * Places the pinned Devsy CLI for each packaging target into
 * resources/bin/<target>/devsy[.exe], where electron-builder picks it up via
 * extraResources (resources/bin/${os}-${arch} → <app resources>/bin).
 *
 *   node scripts/fetch-devsy.mjs --targets mac-x64,mac-arm64
 *   node scripts/fetch-devsy.mjs                 # host target only
 *
 * Default source: the GitHub release pinned in resources/devsy/devsy.json,
 * downloaded once into .cache/devsy/<version>/ and verified by SHA-256.
 *
 * Development override: DEVSY_LOCAL_DIST=/path/to/devsy/dist copies a local
 * build instead (goreleaser layout devsy-dev_<goos>_<goarch>_<suffix>/devsy,
 * or flat devsy-<goos>-<goarch>). Local builds are NOT checksum-verified; a warning
 * is printed and the result must never be released.
 */
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** electron-builder os name → Go GOOS */
const GOOS = { mac: "darwin", win: "windows", linux: "linux" }
/** electron-builder arch name → Go GOARCH */
const GOARCH = { x64: "amd64", arm64: "arm64" }

export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = { darwin: "mac", win32: "win", linux: "linux" }[platform]
  if (!os || !GOARCH[arch])
    throw new Error(`unsupported host ${platform}/${arch}`)
  return `${os}-${arch}`
}

export function parseTargets(argv) {
  const i = argv.indexOf("--targets")
  if (i === -1) return [hostTarget()]
  const value = argv[i + 1]
  if (!value) throw new Error("--targets needs a value, e.g. mac-x64,mac-arm64")
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
}

export function binaryName(target) {
  return target.startsWith("win-") ? "devsy.exe" : "devsy"
}

/** Candidate paths of a local Devsy build for a target, most specific first. */
export function localCandidates(distDir, target) {
  const [os, arch] = target.split("-")
  const goos = GOOS[os]
  const goarch = GOARCH[arch]
  const name = binaryName(target)
  const candidates = []
  if (existsSync(distDir)) {
    for (const entry of readdirSync(distDir).sort()) {
      if (
        entry.startsWith(`devsy-dev_${goos}_${goarch}`) ||
        entry.startsWith(`devsy_${goos}_${goarch}`)
      ) {
        candidates.push(join(distDir, entry, name))
      }
    }
  }
  candidates.push(
    join(distDir, `devsy-${goos}-${goarch}${os === "win" ? ".exe" : ""}`),
  )
  return candidates
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  const tmp = `${dest}.part`
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  renameSync(tmp, dest)
}

async function fromRelease(pin, target) {
  const entry = pin.binaries[target]
  if (!entry) throw new Error(`no Devsy binary pinned for target ${target}`)
  const cacheDir = join(ROOT, ".cache", "devsy", pin.version)
  mkdirSync(cacheDir, { recursive: true })
  const cached = join(cacheDir, entry.asset)
  if (!existsSync(cached) || sha256(cached) !== entry.sha256) {
    const url = `${pin.baseUrl}/${pin.version}/${entry.asset}`
    console.log(`fetch-devsy: downloading ${url}`)
    await download(url, cached)
  }
  const actual = sha256(cached)
  if (actual !== entry.sha256) {
    rmSync(cached, { force: true })
    throw new Error(
      `checksum mismatch for ${entry.asset}: expected ${entry.sha256}, got ${actual}`,
    )
  }
  return cached
}

function fromLocal(distDir, target) {
  const found = localCandidates(distDir, target).find((p) => existsSync(p))
  if (!found)
    throw new Error(`no local Devsy build for ${target} in ${distDir}`)
  console.warn(
    `fetch-devsy: WARNING using unverified local build ${found} — never release this`,
  )
  return found
}

async function main() {
  const pin = JSON.parse(
    readFileSync(join(ROOT, "resources", "devsy", "devsy.json"), "utf8"),
  )
  const targets = parseTargets(process.argv.slice(2))
  const localDist = process.env.DEVSY_LOCAL_DIST

  for (const target of targets) {
    const source = localDist
      ? fromLocal(localDist, target)
      : await fromRelease(pin, target)
    const outDir = join(ROOT, "resources", "bin", target)
    mkdirSync(outDir, { recursive: true })
    const out = join(outDir, binaryName(target))
    copyFileSync(source, out)
    chmodSync(out, 0o755)
    console.log(
      `fetch-devsy: ${target} → ${out} (${localDist ? "local" : pin.version})`,
    )
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`fetch-devsy: ${error.message}`)
    process.exit(1)
  })
}

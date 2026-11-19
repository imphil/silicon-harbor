import { z } from "zod"
import manifestJson from "../../../resources/installers/manifest.json"

/**
 * Pinned vendor installers (resources/installers/manifest.json). Checksums come
 * from the vendors' published release metadata; an entry without a sha256 is
 * never run. Update procedure: docs/requirements.md.
 */

export const InstallerIdSchema = z.enum([
  "rancher-desktop",
  "xquartz",
  "git-credential-manager",
  "git-for-windows",
  "docker-credential-icr",
])
export type InstallerId = z.infer<typeof InstallerIdSchema>

/** `<process.platform>-<process.arch>`, e.g. darwin-arm64, win32-x64. */
export const TargetSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "linux-x64",
])
export type Target = z.infer<typeof TargetSchema>

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

export const AssetSchema = z
  .object({
    /** dmg: copy appName to /Applications; pkg: `installer`; msi: msiexec; inno: Inno Setup exe; binary: copy to the user bin dir (see requirements/user-bin.ts). */
    kind: z.enum(["dmg", "pkg", "msi", "inno", "binary"]),
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), "installer URLs must use HTTPS"),
    sha256: Sha256Schema.nullable(),
    /** dmg only: the .app inside the image. */
    appName: z.string().optional(),
  })
  .strict()
export type Asset = z.infer<typeof AssetSchema>

const ItemSchema = z
  .object({
    name: z.string(),
    version: z.string().nullable(),
    homepage: z.string().url(),
    todo: z.string().optional(),
    assets: z.record(TargetSchema, AssetSchema),
  })
  .strict()

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    updated: z.string(),
    items: z.record(InstallerIdSchema, ItemSchema),
  })
  .strict()
export type Manifest = z.infer<typeof ManifestSchema>

export function loadManifest(json: unknown = manifestJson): Manifest {
  return ManifestSchema.parse(json)
}

export function targetOf(platform: string, arch: string): Target | null {
  const parsed = TargetSchema.safeParse(`${platform}-${arch}`)
  return parsed.success ? parsed.data : null
}

export type AssetLookup =
  | {
      ok: true
      name: string
      version: string
      asset: Asset & { sha256: string }
    }
  | { ok: false; reason: string }

/**
 * The installer for one item on one target, only when it can be verified.
 * A missing asset or checksum is a plain-language reason, never a silent run.
 */
export function findAsset(
  manifest: Manifest,
  id: InstallerId,
  platform: string,
  arch: string,
): AssetLookup {
  const item = manifest.items[id]
  if (!item) return { ok: false, reason: `No installer is known for ${id}.` }
  const target = targetOf(platform, arch)
  const asset = target ? item.assets[target] : undefined
  if (!asset || !item.version) {
    return {
      ok: false,
      reason: `${item.name} cannot be installed automatically on this computer yet. Get it from ${item.homepage}`,
    }
  }
  if (!asset.sha256) {
    return {
      ok: false,
      reason: `${item.name} has no published checksum, so Silicon Harbor will not install it. Get it from ${item.homepage}`,
    }
  }
  return {
    ok: true,
    name: item.name,
    version: item.version,
    asset: { ...asset, sha256: asset.sha256 },
  }
}

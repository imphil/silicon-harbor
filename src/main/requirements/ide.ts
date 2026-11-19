import type { IdeId, IdeStatus, RequirementStatus } from "../../shared/api"
import type { Host } from "./host"
import { firstLine, firstVersion, type Requirement } from "./types"

/**
 * Supported IDEs, found the way Devsy finds them when it launches one
 * (devsy pkg/ide/vscode/open.go): the IDE's command-line tool on PATH, then
 * the standard macOS app path.
 */

interface IdeSpec {
  id: IdeId
  label: string
  cli: string
  macPaths: string[]
  downloadUrl: string
  recommended?: boolean
}

/** IBM Bob is the recommended IDE; its official download page. */
export const BOB_DOWNLOAD_URL = "https://bob.ibm.com/download?bob=ide"
export const VSCODE_DOWNLOAD_URL = "https://code.visualstudio.com/download"
export const VSCODIUM_DOWNLOAD_URL = "https://vscodium.com/#install"

/** In the order shown: IBM Bob first. */
export const IDES: IdeSpec[] = [
  {
    id: "bob",
    label: "IBM Bob",
    cli: "bobide",
    macPaths: ["/Applications/Bobide.app/Contents/Resources/app/bin/bobide"],
    downloadUrl: BOB_DOWNLOAD_URL,
    recommended: true,
  },
  {
    id: "vscode",
    label: "Visual Studio Code",
    cli: "code",
    macPaths: [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
    downloadUrl: VSCODE_DOWNLOAD_URL,
  },
  {
    id: "codium",
    label: "VSCodium",
    cli: "codium",
    // Devsy only knows "Codium.app"; VSCodium's own bundle is "VSCodium.app".
    macPaths: [
      "/Applications/Codium.app/Contents/Resources/app/bin/codium",
      "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
    ],
    downloadUrl: VSCODIUM_DOWNLOAD_URL,
  },
]

export interface FoundIde {
  id: IdeId
  label: string
  path: string
  version?: string
}

export async function detectIdes(host: Host): Promise<FoundIde[]> {
  const found: FoundIde[] = []
  for (const spec of IDES) {
    let path = await host.which(spec.cli)
    if (!path && host.platform === "darwin") {
      for (const candidate of spec.macPaths) {
        if (await host.exists(candidate)) {
          path = candidate
          break
        }
      }
    }
    if (!path) continue
    const res = await host.run(path, ["--version"], { timeoutMs: 15_000 })
    const version =
      res.code === 0
        ? (firstVersion(firstLine(res.stdout)) ?? undefined)
        : undefined
    found.push({ id: spec.id, label: spec.label, path, version })
  }
  return found
}

/** Every supported IDE with what was found, for Settings › IDE. */
export function ideStatuses(found: FoundIde[]): IdeStatus[] {
  return IDES.map((spec) => {
    const hit = found.find((f) => f.id === spec.id)
    return {
      id: spec.id,
      label: spec.label,
      installed: Boolean(hit),
      ...(hit?.version ? { version: hit.version } : {}),
      downloadUrl: spec.downloadUrl,
      ...(spec.recommended ? { recommended: true } : {}),
    }
  })
}

export const ide: Requirement = {
  id: "ide",

  async check(ctx): Promise<RequirementStatus> {
    const found = await detectIdes(ctx.host)
    const base = { id: "ide" as const, title: "IDE", ides: ideStatuses(found) }
    if (found.length === 0) {
      return {
        ...base,
        state: "missing",
        detail:
          "No supported IDE found. Install IBM Bob (recommended), VS Code or VSCodium.",
        fix: { label: "Get IBM Bob" },
      }
    }
    let preferred = ctx.settings().defaultIde
    // With a single IDE there is nothing to choose: it becomes the default.
    if (found.length === 1 && found[0].id !== preferred) {
      preferred = found[0].id
      ctx.updateSettings({ defaultIde: preferred })
    }
    const main = found.find((f) => f.id === preferred)
    if (!main) {
      const label = IDES.find((s) => s.id === preferred)?.label ?? preferred
      return {
        ...base,
        state: "warn",
        detail: `${label} was not found. Found: ${found.map((f) => f.label).join(", ")}. Change the default IDE in Settings › IDE.`,
      }
    }
    const others = found.filter((f) => f !== main).map((f) => f.label)
    return {
      ...base,
      state: "ok",
      version: main.version,
      detail: [main.label, ...others].join(", "),
    }
  },

  async fix(ctx) {
    await ctx.host.openExternal(BOB_DOWNLOAD_URL)
    return undefined
  },
}

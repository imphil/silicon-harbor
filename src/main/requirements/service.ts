import { z } from "zod"
import type {
  RequirementId,
  RequirementStatus,
  Settings,
} from "../../shared/api"
import { downloadVerified } from "../installers/download"
import { runInstaller } from "../installers/install"
import {
  findAsset,
  type InstallerId,
  type Manifest,
} from "../installers/manifest"
import type { Host } from "./host"
import { requirementsFor } from "./registry"
import type { Pending, Requirement, RequirementContext } from "./types"

/**
 * Runs the requirement checks and fixes for this computer ("This computer" in
 * Settings, first-run setup) and keeps the latest result for the renderer.
 */

const PendingFileSchema = z.object({
  /** Machine boot time (ms) when the entries were written; a reboot clears them. */
  bootTime: z.number(),
  entries: z.record(z.string(), z.enum(["relogin", "reboot"])),
})

export interface RequirementServiceDeps {
  host: Host
  manifest: Manifest
  binDir: string
  settings(): Settings
  /** JSON file remembering fixes that wait for a re-login or reboot. */
  pendingFile: string
  /** Approximate boot time in ms (Date.now() - os.uptime() * 1000). */
  bootTime(): number
  onChange(list: RequirementStatus[]): void
  /** Defaults to the real download/installer; replaced in tests. */
  install?(
    ctx: RequirementContext,
    id: InstallerId,
    options?: { binaryDest?: string },
  ): Promise<void>
  sleep?(ms: number): Promise<void>
  requirements?: Requirement[]
  /** Setup log: fixes, their progress and outcome. */
  log?(entry: string): void
}

export class RequirementService {
  private readonly requirements: Requirement[]
  private list: RequirementStatus[] = []
  private readonly working = new Map<RequirementId, string>()
  private checking: Promise<RequirementStatus[]> | null = null

  constructor(private readonly deps: RequirementServiceDeps) {
    this.requirements = deps.requirements ?? requirementsFor(deps.host.platform)
  }

  /** Latest result (empty before the first check). */
  current(): RequirementStatus[] {
    return this.withWorking(this.list)
  }

  /** Runs all checks; concurrent callers share one run. */
  check(): Promise<RequirementStatus[]> {
    if (!this.checking) {
      this.checking = this.runChecks().finally(() => {
        this.checking = null
      })
    }
    return this.checking
  }

  async fix(id: RequirementId): Promise<void> {
    const requirement = this.requirements.find((r) => r.id === id)
    if (!requirement?.fix)
      throw new Error("This item cannot be fixed automatically.")
    if (this.working.has(id))
      throw new Error("This item is already being fixed.")
    const last = this.list.find((s) => s.id === id)
    if (last && !last.fix)
      throw new Error("Nothing to fix here. Check again first.")

    this.working.set(id, "Working…")
    this.emit()
    const log = this.deps.log ?? (() => {})
    log(`fix ${id}: started`)
    try {
      const ctx = await this.context(id)
      const outcome = await requirement.fix(ctx)
      if (outcome?.needsReboot) await this.setPending(id, "reboot")
      else if (outcome?.needsRelogin) await this.setPending(id, "relogin")
      log(
        `fix ${id}: done${outcome?.needsReboot ? " (needs reboot)" : outcome?.needsRelogin ? " (needs re-login)" : ""}`,
      )
    } catch (error) {
      log(`fix ${id}: failed: ${(error as Error).message}`)
      throw error
    } finally {
      this.working.delete(id)
      await this.check()
    }
  }

  private async runChecks(): Promise<RequirementStatus[]> {
    const pending = await this.readPending()
    const resolved = new Set<RequirementId>()
    const results = await Promise.all(
      this.requirements.map(async (r) => {
        if (this.working.has(r.id)) {
          const previous = this.list.find((s) => s.id === r.id)
          if (previous) return previous
        }
        try {
          return await r.check(await this.context(r.id, pending, resolved))
        } catch (error) {
          return {
            id: r.id,
            title: this.list.find((s) => s.id === r.id)?.title ?? r.id,
            state: "warn",
            detail: `Could not be checked: ${(error as Error).message}`,
          } satisfies RequirementStatus
        }
      }),
    )

    // A fix that waited for a re-login/reboot is done once its check saw it.
    const remaining = { ...pending }
    let changed = false
    for (const id of resolved) {
      if (remaining[id]) {
        delete remaining[id]
        changed = true
      }
    }
    if (changed) await this.writePending(remaining)

    this.list = results
    this.emit()
    return this.current()
  }

  private async context(
    id: RequirementId,
    pending?: Partial<Record<RequirementId, Pending>>,
    resolved?: Set<RequirementId>,
  ): Promise<RequirementContext> {
    const { deps } = this
    const pendingMap = pending ?? (await this.readPending())
    const ctx: RequirementContext = {
      host: deps.host,
      manifest: deps.manifest,
      binDir: deps.binDir,
      settings: deps.settings,
      pending: pendingMap[id],
      resolvePending: () => resolved?.add(id),
      progress: (detail) => {
        if (!this.working.has(id)) return
        // Download percentages would flood the log.
        if (!/\d+%$/.test(detail)) this.deps.log?.(`fix ${id}: ${detail}`)
        this.working.set(id, detail)
        this.emit()
      },
      install: (installer, options) =>
        (deps.install ?? defaultInstall)(ctx, installer, options),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    }
    return ctx
  }

  private withWorking(list: RequirementStatus[]): RequirementStatus[] {
    return list.map((status) => {
      const detail = this.working.get(status.id)
      return detail === undefined
        ? status
        : { ...status, state: "working", detail }
    })
  }

  private emit(): void {
    this.deps.onChange(this.current())
  }

  // pending re-login / reboot --------------------------------------------

  private async readPending(): Promise<
    Partial<Record<RequirementId, Pending>>
  > {
    const text = await this.deps.host.readText(this.deps.pendingFile)
    if (!text) return {}
    try {
      const parsed = PendingFileSchema.parse(JSON.parse(text))
      // Booted since the entries were written (1 min tolerance): a reboot
      // also means a fresh login, so everything pending is done.
      if (this.deps.bootTime() > parsed.bootTime + 60_000) {
        if (Object.keys(parsed.entries).length > 0) await this.writePending({})
        return {}
      }
      return parsed.entries as Partial<Record<RequirementId, Pending>>
    } catch {
      return {}
    }
  }

  private async setPending(id: RequirementId, kind: Pending): Promise<void> {
    const entries = { ...(await this.readPending()), [id]: kind }
    await this.writePending(entries)
  }

  private async writePending(
    entries: Partial<Record<RequirementId, Pending>>,
  ): Promise<void> {
    await this.deps.host.writeTextAtomic(
      this.deps.pendingFile,
      `${JSON.stringify({ bootTime: this.deps.bootTime(), entries }, null, 2)}\n`,
    )
  }
}

/** Download → verify sha256 → run, with progress in the "working" detail. */
async function defaultInstall(
  ctx: RequirementContext,
  id: InstallerId,
  options: { binaryDest?: string } = {},
): Promise<void> {
  const { host } = ctx
  const found = findAsset(ctx.manifest, id, host.platform, host.arch)
  if (!found.ok) throw new Error(found.reason)
  const dir = await host.tempDir("sh-install-")
  try {
    ctx.progress(`Downloading ${found.name} ${found.version}…`)
    const file = await downloadVerified({
      url: found.asset.url,
      sha256: found.asset.sha256,
      dir,
      onProgress: (percent) =>
        ctx.progress(
          percent === undefined
            ? `Downloading ${found.name} ${found.version}…`
            : `Downloading ${found.name} ${found.version}… ${percent}%`,
        ),
    })
    ctx.progress(
      host.platform === "win32"
        ? `Installing ${found.name}… Confirm the Windows prompt.`
        : `Installing ${found.name}… You may be asked for your password.`,
    )
    await runInstaller({
      host,
      asset: found.asset,
      file,
      name: found.name,
      binaryDest: options.binaryDest,
    })
  } finally {
    await host.remove(dir)
  }
}

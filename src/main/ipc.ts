import { homedir, userInfo } from "node:os"
import { z } from "zod"
import {
  type AppInfo,
  IpcChannel,
  type RequirementStatus,
  type Settings,
} from "../shared/api"
import type { DevsyClient } from "./devsy/client"
import { WORKSPACE_ID_PATTERN } from "./devsy/ids"
import { buildDiagnostics } from "./diagnostics"
import type { EnvironmentService } from "./environments"
import type { RequirementService } from "./requirements/service"
import { IdeIdSchema, type SettingsStore } from "./settings-store"
import { openTerminal } from "./terminal"

/** The subset of Electron's ipcMain we use (lets tests pass a fake). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void
}

export interface IpcDeps {
  ipcMain: IpcMainLike
  appInfo(): AppInfo
  environments: EnvironmentService
  settings: SettingsStore
  client: DevsyClient
  devsyHome: string
  writeClipboard(text: string): void
  requirements: Pick<RequirementService, "check" | "fix">
  /** The last lines of the setup log (requirement checks and fixes). */
  setupLog?(lines: number): string[]
}

const SETUP_LOG_LINES = 200

const RequirementIdSchema = z.enum([
  "container-engine",
  "wsl",
  "xquartz",
  "credential-helper",
  "git-credentials",
  "ide",
])

const IdSchema = z.string().regex(WORKSPACE_ID_PATTERN)
const CreateSchema = z
  .object({
    repoUrl: z.string().min(1).max(2048),
    branch: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9._/-]*$/, "invalid branch name")
      .optional(),
    name: z.string().max(120).optional(),
    ide: IdeIdSchema.optional(),
  })
  .strict()

/**
 * Registers every request channel of src/shared/api.ts. Arguments from the
 * renderer are validated before they reach the CLI.
 */
export function registerIpc(deps: IpcDeps): void {
  const { ipcMain, environments: envs } = deps
  const on = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (_event, ...args) => fn(...args))

  on(IpcChannel.appInfo, () => deps.appInfo())

  on(IpcChannel.envList, () => envs.list())
  on(IpcChannel.envGet, (id) => envs.get(IdSchema.parse(id)))
  on(IpcChannel.envCreate, (req) => envs.create(CreateSchema.parse(req)))
  on(IpcChannel.envStart, (id) => envs.startEnv(IdSchema.parse(id)))
  on(IpcChannel.envStop, (id) => envs.stopEnv(IdSchema.parse(id)))
  on(IpcChannel.envRebuild, (id) => envs.rebuild(IdSchema.parse(id)))
  on(IpcChannel.envDelete, (id) => envs.delete(IdSchema.parse(id)))
  on(IpcChannel.envCancel, (id) => envs.cancel(IdSchema.parse(id)))
  on(IpcChannel.envOpenIde, (id, ide) =>
    envs.openInIde(IdSchema.parse(id), IdeIdSchema.optional().parse(ide)),
  )
  on(IpcChannel.envOpenTerminal, async (id) => {
    const env = envs.get(IdSchema.parse(id))
    if (!env) throw new Error(`Unknown environment ${String(id)}`)
    const devsyPath = deps.appInfo().devsyPath
    if (!devsyPath) throw new Error("The Devsy CLI is missing")
    await openTerminal({
      platform: process.platform,
      devsyPath,
      devsyHome: deps.devsyHome,
      workspaceId: env.id,
      preferredTerminal: process.env.TERMINAL,
    })
  })
  on(IpcChannel.envLog, (id) => envs.getLog(IdSchema.parse(id)))
  on(IpcChannel.diagnosticsCopy, async (id) => {
    const focusId =
      id === undefined || id === null ? undefined : IdSchema.parse(id)
    const devsyVersion = await deps.client.version().catch(() => "")
    let userName: string | undefined
    try {
      userName = userInfo().username
    } catch {
      userName = undefined
    }
    deps.writeClipboard(
      buildDiagnostics({
        app: deps.appInfo(),
        devsyVersion,
        devsyHome: deps.devsyHome,
        homeDir: homedir(),
        userName,
        environments: envs.list(),
        focus: focusId ? { id: focusId, log: envs.getLog(focusId) } : undefined,
        setupLog: deps.setupLog?.(SETUP_LOG_LINES),
      }),
    )
  })

  on(
    IpcChannel.reqCheck,
    (): Promise<RequirementStatus[]> => deps.requirements.check(),
  )
  on(IpcChannel.reqFix, (id) =>
    deps.requirements.fix(RequirementIdSchema.parse(id)),
  )

  on(IpcChannel.settingsGet, (): Settings => deps.settings.get())
  on(IpcChannel.settingsUpdate, (patch) => deps.settings.update(patch))
}

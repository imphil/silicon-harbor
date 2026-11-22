import { randomUUID } from "node:crypto"
import { type FSWatcher, watch } from "node:fs"
import type {
  CreateEnvironmentRequest,
  Environment,
  EnvironmentState,
  IdeId,
  LogLine,
  Operation,
  OperationKind,
  Settings,
} from "../shared/api"
import { checkRepoUrl } from "../shared/repo-url"
import { type DevsyClient, DevsyError, type UpArgs } from "./devsy/client"
import { classifyFailure, type FailureInput } from "./devsy/errors"
import { uniqueWorkspaceId } from "./devsy/ids"
import {
  applyStatus,
  cloneSteps,
  createProgress,
  eventKey,
  finishProgress,
  type Progress,
  phaseDetail,
} from "./devsy/progress"
import type { StreamHandle } from "./devsy/runner"
import type {
  CliErrorInfo,
  ResultEnvelope,
  SetupLogRecord,
  WorkspaceListEntry,
} from "./devsy/schemas"
import type { LogStore } from "./log-store"

export interface EnvironmentServiceOptions {
  client: DevsyClient
  logs: LogStore
  settings: () => Settings
  onChange(envs: Environment[]): void
  onLog(id: string, line: LogLine): void
  /** How the IDE is launched after `up` (default "auto"). */
  ideLaunch?: UpArgs["ideLaunch"]
  /** Passed as --ide instead of the environment's IDE (integration tests: "none"). */
  ideOverride?: string
  /** Passed as --ssh-config (integration tests); default: Devsy's (~/.ssh/config). */
  sshConfigPath?: string
  /**
   * New environments clone their source into a Docker volume instead of a
   * host folder (macOS/Windows: avoids the slow host↔VM file sharing).
   */
  cloneIntoVolume?: boolean
  /**
   * `--secret` specs for every `up` (create, start, rebuild): the credentials
   * from Settings › Credentials (credentials/service.ts).
   */
  upSecrets?: () => Promise<string[]>
  /** DEVSY_HOME, watched for changes made by other Devsy clients. */
  watchDir?: string
  listIntervalMs?: number
  statusIntervalMs?: number
  /**
   * How often the setup history (lifecycle hook and image build output) is
   * read while an `up` runs. `workspace logs --follow` can end before the
   * run does, so we poll with a cursor instead.
   */
  setupLogIntervalMs?: number
  now?: () => Date
}

interface RunningOp {
  operation: Operation
  progress: Progress
  taskId?: string
  runId?: string
  handle?: StreamHandle
  cancelRequested: boolean
}

interface EnvRecord {
  id: string
  name: string
  repoUrl: string
  branch?: string
  ide: IdeId
  createdAt?: string
  lastUsedAt?: string
  /** Raw `workspace status` state, e.g. "Running". */
  devsyState?: string
  /** Known to `workspace list`. */
  exists: boolean
  op?: RunningOp
  /** A quiet `up` that only writes renewed secret files (deliverSecrets). */
  delivering?: boolean
  /** Last failed or cancelled operation. */
  lastOp?: Operation
  /** For environments whose creation failed before Devsy created a workspace. */
  createRequest?: { repoUrl: string; branch?: string; name: string }
}

const IDES: IdeId[] = ["vscode", "bob", "codium"]
const UP_KINDS: OperationKind[] = ["create", "start", "rebuild"]
const STATUS_BACKOFF_MAX_MS = 5 * 60_000
/** Setup output lines shown per operation; the rest stays in Devsy's store. */
const SETUP_LOG_MAX_LINES = 5000
const SETUP_LOG_INTERVAL_MS = 3000

export class BusyError extends Error {
  constructor(id: string) {
    super(`An operation is already running for ${id}`)
  }
}

export class EnvironmentService {
  private readonly records = new Map<string, EnvRecord>()
  private providerReady?: Promise<void>
  private timers: ReturnType<typeof setInterval>[] = []
  private watcher?: FSWatcher
  private watchDebounce?: ReturnType<typeof setTimeout>
  private emitQueued = false
  private statusFailures = new Map<string, { count: number; retryAt: number }>()
  private listInFlight?: Promise<void>
  private stopped = false

  constructor(private readonly opts: EnvironmentServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Initial load, re-attach to running tasks, then periodic refresh. */
  async start(): Promise<void> {
    await this.refreshList().catch(() => {})
    await this.refreshStatuses().catch(() => {})
    await this.reattach().catch(() => {})
    if (this.stopped) return
    this.timers.push(
      setInterval(
        () => void this.refreshList().catch(() => {}),
        this.opts.listIntervalMs ?? 10_000,
      ),
      setInterval(
        () => void this.refreshStatuses(undefined, true).catch(() => {}),
        this.opts.statusIntervalMs ?? 15_000,
      ),
    )
    this.startWatching()
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.watcher?.close()
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
  }

  private startWatching(): void {
    if (!this.opts.watchDir) return
    try {
      this.watcher = watch(
        this.opts.watchDir,
        { recursive: true, persistent: false },
        (_event, file) => {
          const name = String(file ?? "")
          if (/(^|[\\/])(run|logs|state)([\\/]|$)/.test(name)) return
          if (this.watchDebounce) clearTimeout(this.watchDebounce)
          this.watchDebounce = setTimeout(
            () => void this.refreshList().catch(() => {}),
            1000,
          )
        },
      )
      this.watcher.on("error", () => this.watcher?.close())
    } catch {
      // Watching is an optimisation; polling covers it.
    }
  }

  // -------------------------------------------------------------------------
  // Queries

  list(): Environment[] {
    return [...this.records.values()]
      .map((r) => this.view(r))
      .sort(
        (a, b) =>
          (b.lastUsedAt ?? b.createdAt ?? "").localeCompare(
            a.lastUsedAt ?? a.createdAt ?? "",
          ) || a.name.localeCompare(b.name),
      )
  }

  get(id: string): Environment | null {
    const r = this.records.get(id)
    return r ? this.view(r) : null
  }

  getLog(id: string): LogLine[] {
    return [...this.opts.logs.read(id)]
  }

  private view(r: EnvRecord): Environment {
    const operation = r.op
      ? { ...r.op.operation, steps: cloneSteps(r.op.progress) }
      : r.lastOp
    return {
      id: r.id,
      name: r.name,
      repoUrl: r.repoUrl,
      branch: r.branch,
      ide: r.ide,
      state: this.stateOf(r),
      operation,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }
  }

  private stateOf(r: EnvRecord): EnvironmentState {
    if (r.op) return "busy"
    if (!r.exists) return r.lastOp ? "failed" : "unknown"
    const devsy = r.devsyState?.toLowerCase()
    // After a cancelled up, Devsy may report Running although setup did not
    // finish (docs/developer/devsy/cli-contract.md §5).
    if (
      r.lastOp?.state === "cancelled" &&
      UP_KINDS.includes(r.lastOp.kind) &&
      devsy === "running"
    )
      return "failed"
    switch (devsy) {
      case "running":
        return "running"
      case "stopped":
        return "stopped"
      case "provisioning":
      case "busy":
        return "busy"
      case "failed":
        return "failed"
      default:
        return "unknown"
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  async create(req: CreateEnvironmentRequest): Promise<{ id: string }> {
    const check = checkRepoUrl(req.repoUrl)
    if (!check.ok) throw new Error(`Invalid repository URL (${check.reason})`)
    const repoUrl = req.repoUrl.trim().replace(/\/+$/, "")
    const branch = req.branch?.trim() || undefined
    const displayName = req.name?.trim() || undefined
    const name = displayName ?? check.name
    const id = uniqueWorkspaceId(name, this.records.keys())
    const ide = req.ide ?? this.opts.settings().defaultIde

    const record: EnvRecord = {
      id,
      name,
      repoUrl,
      branch,
      ide,
      exists: false,
      createdAt: this.now().toISOString(),
      lastUsedAt: this.now().toISOString(),
      createRequest: { repoUrl, branch, name },
    }
    this.records.set(id, record)
    this.submitCreate(record, displayName)
    return { id }
  }

  private submitCreate(record: EnvRecord, displayName?: string): void {
    const req = record.createRequest
    if (!req) return
    this.runUp(record, "create", {
      source: req.branch ? `${req.repoUrl}@${req.branch}` : req.repoUrl,
      id: record.id,
      displayName,
      cloneIntoVolume: this.opts.cloneIntoVolume,
    })
  }

  async startEnv(id: string): Promise<void> {
    const r = this.require(id)
    if (!r.exists && r.createRequest) {
      // Creation failed before Devsy created a workspace: try again.
      this.submitCreate(r, r.name !== r.id ? r.name : undefined)
      return
    }
    this.runUp(r, "start", { source: id })
  }

  async rebuild(id: string): Promise<void> {
    this.runUp(this.require(id), "rebuild", { source: id, recreate: true })
  }

  async openInIde(id: string, ide?: IdeId): Promise<void> {
    const r = this.require(id)
    this.assertIdle(r)
    if (ide && ide !== r.ide) {
      if (r.exists) await this.opts.client.setIde(id, ide)
      r.ide = ide
      this.emit()
    }
    if (!r.exists && r.createRequest) {
      this.submitCreate(r)
      return
    }
    this.runUp(r, "start", { source: id })
  }

  async stopEnv(id: string): Promise<void> {
    const r = this.require(id)
    this.runDirect(r, "stop", (cb) => this.opts.client.stop(id, cb))
  }

  async delete(id: string): Promise<void> {
    const r = this.require(id)
    if (!r.exists && !r.op) {
      // Nothing in Devsy: just forget the failed placeholder.
      this.records.delete(id)
      this.opts.logs.remove(id)
      this.emit()
      return
    }
    this.runDirect(r, "delete", (cb) => this.opts.client.delete(id, cb))
  }

  async cancel(id: string): Promise<void> {
    const r = this.require(id)
    const run = r.op
    if (!run) return
    run.cancelRequested = true
    this.log(id, "warn", "Cancelling…")
    if (run.taskId) {
      await this.opts.client.cancelTask(run.taskId).catch((error: unknown) => {
        this.log(id, "warn", `Cancel failed: ${(error as Error).message}`)
      })
    } else if (run.handle) {
      run.handle.cancel()
    }
    // Without a task id yet, runUp cancels right after submitting.
  }

  private require(id: string): EnvRecord {
    const r = this.records.get(id)
    if (!r) throw new Error(`Unknown environment ${id}`)
    return r
  }

  private assertIdle(r: EnvRecord): void {
    if (r.op || r.delivering) throw new BusyError(r.id)
  }

  // -------------------------------------------------------------------------
  // Operations

  private beginOp(r: EnvRecord, kind: OperationKind): RunningOp {
    this.assertIdle(r)
    const run: RunningOp = {
      operation: {
        id: randomUUID(),
        kind,
        state: "running",
        steps: [],
        startedAt: this.now().toISOString(),
      },
      progress: createProgress(kind),
      cancelRequested: false,
    }
    r.op = run
    r.lastOp = undefined
    r.lastUsedAt = this.now().toISOString()
    this.log(r.id, "info", `── ${OP_TITLE[kind]} ${r.name} ──`)
    this.emit()
    return run
  }

  private endOp(
    r: EnvRecord,
    run: RunningOp,
    outcome: { ok: true } | { ok: false; failure: FailureInput },
  ): void {
    if (r.op !== run) return
    const op = run.operation
    op.finishedAt = this.now().toISOString()

    if (outcome.ok) {
      finishProgress(run.progress, "succeeded")
      op.state = "succeeded"
      op.steps = cloneSteps(run.progress)
      r.op = undefined
      r.lastOp = undefined
      this.log(r.id, "info", OP_DONE[op.kind])
    } else {
      const classified = classifyFailure(outcome.failure, { ide: r.ide })
      if (classified.cancelled || run.cancelRequested) {
        finishProgress(run.progress, "cancelled")
        op.state = "cancelled"
        this.log(r.id, "warn", "Cancelled.")
      } else {
        finishProgress(run.progress, "failed", classified.step)
        op.state = "failed"
        op.error = classified.error
        this.log(
          r.id,
          "error",
          `${classified.error.title}. ${classified.error.message}`,
        )
      }
      op.steps = cloneSteps(run.progress)
      r.op = undefined
      r.lastOp = op
    }
    this.emit()
  }

  /**
   * Starts a detached `up`. Throws synchronously (BusyError) when another
   * operation runs; everything after that is reported through the operation.
   */
  private runUp(
    r: EnvRecord,
    kind: OperationKind,
    args: Omit<UpArgs, "ide" | "ideLaunch" | "sshConfigPath">,
  ): Promise<void> {
    const run = this.beginOp(r, kind)
    return this.submitAndFollow(r, run, args)
  }

  private async submitAndFollow(
    r: EnvRecord,
    run: RunningOp,
    args: Omit<UpArgs, "ide" | "ideLaunch" | "sshConfigPath">,
  ): Promise<void> {
    try {
      await this.ensureProvider()
      const secrets = (await this.opts.upSecrets?.()) ?? []
      const task = await this.opts.client.submitUp({
        ...args,
        // Every create/start hook runs before the IDE opens, with the
        // credentials (docs/developer/credentials.md); deferred hooks would get none.
        waitFor: "postStartCommand",
        ...(secrets.length > 0 ? { secrets } : {}),
        ide: this.opts.ideOverride ?? r.ide,
        ideLaunch: this.opts.ideLaunch ?? "auto",
        sshConfigPath: this.opts.sshConfigPath,
      })
      run.taskId = task.id
      run.runId = task.runId
      if (run.cancelRequested)
        await this.opts.client.cancelTask(task.id).catch(() => {})
    } catch (error) {
      this.endOp(r, run, { ok: false, failure: failureOf(error) })
      return
    }
    await this.follow(r, run)
  }

  /**
   * Writes renewed secret files (Settings › Credentials) into every running
   * environment: a quiet `up` without IDE launch, not shown as an operation.
   * Environments busy with an operation of their own are left for a later
   * call; a stopped one gets the files at its next start.
   */
  async deliverSecrets(): Promise<{
    delivered: number
    busy: number
    failed: number
  }> {
    const running = [...this.records.values()].filter(
      (r) => r.exists && this.stateOf(r) === "running",
    )
    const result = { delivered: 0, busy: 0, failed: 0 }
    for (const r of running) {
      if (r.op || r.delivering) {
        result.busy++
        continue
      }
      r.delivering = true
      try {
        await this.quietUp(r)
        result.delivered++
      } catch (error) {
        result.failed++
        this.log(
          r.id,
          "warn",
          `Could not update the credentials: ${(error as Error).message}`,
        )
      } finally {
        r.delivering = false
      }
    }
    return result
  }

  private async quietUp(r: EnvRecord): Promise<void> {
    const secrets = (await this.opts.upSecrets?.()) ?? []
    const task = await this.opts.client.submitUp({
      source: r.id,
      waitFor: "postStartCommand",
      ...(secrets.length > 0 ? { secrets } : {}),
      ide: this.opts.ideOverride ?? r.ide,
      ideLaunch: "skip",
      sshConfigPath: this.opts.sshConfigPath,
    })
    let failure: string | undefined
    let succeeded = false
    const handle = this.opts.client.followTask(task.id, {
      onEnvelope: (envelope) => {
        if (envelope.kind === "result") succeeded = true
        else if (envelope.kind === "error")
          failure = envelope.message || "Devsy reported an error."
      },
      onLog: () => {},
      onText: () => {},
    })
    const code = await handle.done
    if (!succeeded || code !== 0)
      throw new Error(failure ?? `Devsy exited with code ${code}.`)
  }

  /** Follows a detached `up` task to its end. */
  private async follow(r: EnvRecord, run: RunningOp): Promise<void> {
    if (!run.taskId) return
    let result: ResultEnvelope | undefined
    let error: CliErrorInfo | undefined
    const logErrors: string[] = []

    const setupLog = this.followSetupLog(r, run)
    run.handle = this.opts.client.followTask(run.taskId, {
      onEnvelope: (envelope) => {
        if (envelope.kind === "status") {
          const seen = run.progress.seen.has(eventKey(envelope))
          if (!seen) this.logStatus(r.id, envelope)
          if (envelope.state === "failed" && envelope.error)
            error ??= envelope.error
          if (applyStatus(run.progress, envelope)) this.emit()
        } else if (envelope.kind === "result") {
          result = envelope
        } else if (envelope.kind === "error") {
          error = envelope
          this.log(r.id, "error", envelope.message)
        }
      },
      onLog: (record) => {
        const level = levelOf(record.level)
        if (level === "error") logErrors.push(record.msg)
        this.log(r.id, level, record.msg)
      },
      onText: (text) => this.log(r.id, "info", text),
    })

    const code = await run.handle.done
    // The rest of the setup output, before the outcome.
    await setupLog.stop()
    // Devsy created the workspace (or knew it already) unless the clone failed.
    await this.refreshList().catch(() => {})
    if (result && code === 0) {
      r.devsyState = "Running"
      this.endOp(r, run, { ok: true })
    } else {
      this.endOp(r, run, {
        ok: false,
        failure: {
          code: error?.code,
          message: error?.message || `devsy exited with code ${code}`,
          hint: error?.hint,
          logErrors,
        },
      })
    }
    await this.refreshStatuses([r.id]).catch(() => {})
  }

  /** stop / delete: not detached, status events on stdout. Throws BusyError synchronously. */
  private runDirect(
    r: EnvRecord,
    kind: "stop" | "delete",
    start: (callbacks: Parameters<DevsyClient["stop"]>[1]) => StreamHandle,
  ): Promise<void> {
    const run = this.beginOp(r, kind)
    return this.followDirect(r, run, kind, start)
  }

  private async followDirect(
    r: EnvRecord,
    run: RunningOp,
    kind: "stop" | "delete",
    start: (callbacks: Parameters<DevsyClient["stop"]>[1]) => StreamHandle,
  ): Promise<void> {
    let error: CliErrorInfo | undefined
    const logErrors: string[] = []
    run.handle = start({
      onEnvelope: (envelope) => {
        if (envelope.kind === "status") {
          if (envelope.state === "failed" && envelope.error)
            error ??= envelope.error
          if (applyStatus(run.progress, envelope)) this.emit()
          if (envelope.step && envelope.state === "started")
            this.log(r.id, "info", `${envelope.step}…`)
        } else if (envelope.kind === "error") {
          error = envelope
          this.log(r.id, "error", envelope.message)
        }
      },
      onLog: (record) => {
        const level = levelOf(record.level)
        if (level === "error") logErrors.push(record.msg)
        this.log(r.id, level, record.msg)
      },
      onText: (text) => this.log(r.id, "info", text),
    })
    const code = await run.handle.done

    // Deleting something that is already gone counts as success.
    if (code === 0 || (kind === "delete" && code === 75)) {
      if (kind === "stop") r.devsyState = "Stopped"
      this.endOp(r, run, { ok: true })
      if (kind === "delete") {
        this.records.delete(r.id)
        this.opts.logs.remove(r.id)
        this.emit()
        return
      }
    } else {
      this.endOp(r, run, {
        ok: false,
        failure: {
          code: error?.code,
          message: error?.message || `devsy exited with code ${code}`,
          hint: error?.hint,
          logErrors,
        },
      })
    }
    await this.refreshStatuses([r.id]).catch(() => {})
  }

  /** Follows `up` tasks that were already running when the app started. */
  private async reattach(): Promise<void> {
    const tasks = await this.opts.client.listTasks()
    for (const task of tasks) {
      if (
        task.status !== "running" ||
        task.command !== "up" ||
        !task.workspaceId
      )
        continue
      const r = this.records.get(task.workspaceId)
      if (!r || r.op) continue
      const run = this.beginOp(r, "start")
      run.taskId = task.id
      run.runId = task.runId
      void this.follow(r, run)
    }
  }

  private ensureProvider(): Promise<void> {
    this.providerReady ??= (async () => {
      const client = this.opts.client
      const names = await client.providerNames()
      if (!names.includes("docker")) {
        await client.addProvider("docker")
        await client.initProvider("docker")
      }
      await client.useProvider("docker")
      // Forward the host's GitHub CLI sign-in into environments (gh there
      // uses it; Git uses the credential helper forwarding, on by default).
      await client.setContextOptions({ SSH_INJECT_GITHUB_CREDENTIALS: "true" })
    })().catch((error: unknown) => {
      this.providerReady = undefined
      throw error
    })
    return this.providerReady
  }

  /**
   * Shows the run's setup history (initializeCommand and other lifecycle
   * hooks, the image build) in the environment log while it runs. Records
   * are shown once each (producer + sequence); stop() reads the rest.
   */
  private followSetupLog(
    r: EnvRecord,
    run: RunningOp,
  ): { stop(): Promise<void> } {
    const runId = run.runId
    if (!runId) return { stop: async () => {} }
    const seen = new Set<string>()
    let after: string | undefined
    let shown = 0
    let truncated = false
    let stopped = false
    let wake: (() => void) | undefined

    const show = (rec: SetupLogRecord) => {
      if (rec.kind !== "output" || !rec.text) return
      for (const line of rec.text.replace(/\n$/, "").split("\n")) {
        if (shown === 0) this.log(r.id, "info", "── Setup output ──")
        if (shown >= SETUP_LOG_MAX_LINES) {
          if (!truncated)
            this.log(
              r.id,
              "warn",
              `More setup output than shown here: devsy workspace logs ${r.id} --source setup --run ${runId}`,
            )
          truncated = true
          return
        }
        shown++
        this.log(
          r.id,
          rec.stream === "stderr" ? "warn" : "info",
          line,
          rec.time,
        )
      }
    }
    const drain = async () => {
      // Bounded: a long build log comes in pages.
      for (let page = 0; page < 100; page++) {
        const res = await this.opts.client.readSetupLog(r.id, runId, after)
        for (const rec of res.records) {
          const key = `${rec.producerId ?? ""}:${rec.sequence ?? ""}:${rec.kind}:${rec.time ?? ""}`
          if (seen.has(key)) continue
          seen.add(key)
          show(rec)
        }
        if (res.nextCursor) after = res.nextCursor
        if (!res.hasMore) return
      }
    }
    const interval = this.opts.setupLogIntervalMs ?? SETUP_LOG_INTERVAL_MS
    const loop = (async () => {
      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        if (stopped) return
        // Before Devsy has created the workspace this fails; try again.
        await drain().catch(() => {})
      }
    })()
    return {
      stop: async () => {
        stopped = true
        wake?.()
        await loop
        await drain().catch(() => {})
      },
    }
  }

  // -------------------------------------------------------------------------
  // Refresh

  refreshList(): Promise<void> {
    this.listInFlight ??= this.doRefreshList().finally(() => {
      this.listInFlight = undefined
    })
    return this.listInFlight
  }

  private async doRefreshList(): Promise<void> {
    const entries = await this.opts.client.listWorkspaces()
    const seen = new Set<string>()
    const added: string[] = []
    for (const entry of entries) {
      seen.add(entry.id)
      const existing = this.records.get(entry.id)
      if (!existing) added.push(entry.id)
      this.records.set(entry.id, this.merge(existing, entry))
    }
    for (const [id, r] of this.records) {
      if (seen.has(id)) continue
      // Keep running operations and failed placeholders.
      if (r.op || (r.lastOp && r.createRequest)) {
        r.exists = false
        continue
      }
      this.records.delete(id)
    }
    this.emit()
    if (added.length > 0) await this.refreshStatuses(added)
  }

  /**
   * Updates the record in place: running operations hold a reference to it,
   * so it must keep its identity across refreshes.
   */
  private merge(
    existing: EnvRecord | undefined,
    e: WorkspaceListEntry,
  ): EnvRecord {
    const ideName = e.ide?.name as IdeId | undefined
    const source = e.source ?? {}
    return Object.assign(existing ?? ({} as EnvRecord), {
      id: e.id,
      name: e.effectiveDisplayName || e.displayName || existing?.name || e.id,
      repoUrl:
        source.gitRepository ??
        source.localFolder ??
        source.image ??
        existing?.repoUrl ??
        "",
      branch: source.gitBranch ?? existing?.branch,
      ide:
        ideName && IDES.includes(ideName)
          ? ideName
          : (existing?.ide ?? this.opts.settings().defaultIde),
      createdAt: e.creationTimestamp ?? existing?.createdAt,
      lastUsedAt: e.lastUsed ?? existing?.lastUsedAt,
      exists: true,
      createRequest: undefined,
    })
  }

  /** Polls `workspace status`, a few at a time, with backoff for failures. */
  async refreshStatuses(ids?: string[], scheduled = false): Promise<void> {
    const now = Date.now()
    const queue = (ids ?? [...this.records.keys()]).filter((id) => {
      const r = this.records.get(id)
      if (!r?.exists || r.op) return false
      if (!scheduled) return true
      const failure = this.statusFailures.get(id)
      return !failure || failure.retryAt <= now
    })
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const status = await this.opts.client.status(id)
          const r = this.records.get(id)
          if (!r || r.op) continue
          this.statusFailures.delete(id)
          if (status === null) {
            this.records.delete(id)
            this.emit()
          } else if (status.state !== r.devsyState) {
            r.devsyState = status.state
            if (status.state.toLowerCase() === "failed" && !r.lastOp)
              r.lastOp = this.failedFromStatus(status.lastOperation?.error)
            this.emit()
          }
        } catch {
          const count = (this.statusFailures.get(id)?.count ?? 0) + 1
          this.statusFailures.set(id, {
            count,
            retryAt:
              Date.now() +
              Math.min(
                STATUS_BACKOFF_MAX_MS,
                (this.opts.statusIntervalMs ?? 15_000) * 2 ** count,
              ),
          })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  }

  /** A failed workspace found by polling (e.g. failed before the app started). */
  private failedFromStatus(
    error: CliErrorInfo | undefined,
  ): Operation | undefined {
    if (!error) return undefined
    const classified = classifyFailure(error)
    if (classified.cancelled) return undefined
    const progress = createProgress("start")
    finishProgress(progress, "failed", classified.step)
    return {
      id: randomUUID(),
      kind: "start",
      state: "failed",
      steps: cloneSteps(progress),
      error: classified.error,
      startedAt: this.now().toISOString(),
      finishedAt: this.now().toISOString(),
    }
  }

  // -------------------------------------------------------------------------
  // Events

  private emit(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    queueMicrotask(() => {
      this.emitQueued = false
      this.opts.onChange(this.list())
    })
  }

  private log(
    id: string,
    level: LogLine["level"],
    text: string,
    ts?: string,
  ): void {
    const line: LogLine = { ts: ts ?? this.now().toISOString(), level, text }
    this.opts.logs.append(id, line)
    this.opts.onLog(id, line)
  }

  private logStatus(
    id: string,
    event: {
      phase: string
      state: string
      step?: string
      durationMs?: number
      error?: CliErrorInfo
    },
  ): void {
    const what = event.step ?? phaseDetail(event.phase) ?? event.phase
    if (event.state === "started") this.log(id, "info", `${what}…`)
    else if (
      event.state === "succeeded" &&
      event.durationMs !== undefined &&
      event.durationMs >= 1000
    )
      this.log(
        id,
        "info",
        `${what}: done (${(event.durationMs / 1000).toFixed(1)} s)`,
      )
    else if (event.state === "failed")
      this.log(
        id,
        "error",
        `${what}: failed${event.error?.message ? ` — ${event.error.message}` : ""}`,
      )
  }
}

const OP_TITLE: Record<OperationKind, string> = {
  create: "Creating",
  start: "Starting",
  stop: "Stopping",
  rebuild: "Rebuilding",
  delete: "Deleting",
}

const OP_DONE: Record<OperationKind, string> = {
  create: "Environment ready.",
  start: "Environment ready.",
  stop: "Environment stopped.",
  rebuild: "Environment rebuilt.",
  delete: "Environment deleted.",
}

function levelOf(level: string | undefined): LogLine["level"] {
  const l = level?.toLowerCase()
  if (l === "warn" || l === "warning") return "warn"
  if (l === "error" || l === "fatal" || l === "panic" || l === "dpanic")
    return "error"
  return "info"
}

function failureOf(error: unknown): FailureInput {
  if (error instanceof DevsyError)
    return {
      code: error.cliError?.code,
      message: error.cliError?.message || error.message,
      hint: error.cliError?.hint,
      logErrors: error.logErrors,
    }
  return { message: error instanceof Error ? error.message : String(error) }
}

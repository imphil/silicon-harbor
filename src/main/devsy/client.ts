import type { z } from "zod"
import type { CliResult, CliStream, DevsyCli, StreamHandle } from "./runner"
import {
  type CliErrorInfo,
  type Envelope,
  type LogRecord,
  type ParsedLine,
  ProviderListSchema,
  parseLine,
  type SetupLogRead,
  SetupLogReadSchema,
  type TaskEnvelope,
  TaskEnvelopeSchema,
  TaskListSchema,
  type TaskRecord,
  type WorkspaceListEntry,
  WorkspaceListSchema,
  type WorkspaceStatus,
  WorkspaceStatusSchema,
} from "./schemas"

/** Exit code for "workspace not found" (cmd/root.go). */
export const EXIT_NOT_FOUND = 75

/** A failed CLI call, with the structured error if the CLI reported one. */
export class DevsyError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly cliError?: CliErrorInfo,
    /** Error-level log messages seen on stderr (they often hold the real cause). */
    readonly logErrors: string[] = [],
  ) {
    super(message)
    this.name = "DevsyError"
  }

  get notFound(): boolean {
    return this.exitCode === EXIT_NOT_FOUND
  }
}

/** Extracts the error envelope / error logs from a finished command. */
export function errorFromResult(
  result: CliResult,
  fallback: string,
): DevsyError {
  let cliError: CliErrorInfo | undefined
  const logErrors: string[] = []
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const parsed = parseLine(line)
    if (parsed?.type === "envelope" && parsed.envelope.kind === "error") {
      cliError = parsed.envelope
    } else if (parsed?.type === "log" && isErrorLevel(parsed.record.level)) {
      logErrors.push(parsed.record.msg)
    }
  }
  const message =
    cliError?.message ||
    logErrors.at(-1) ||
    result.stderr.trim().split(/\r?\n/).at(-1) ||
    fallback
  return new DevsyError(message, result.code, cliError, logErrors)
}

export function isErrorLevel(level: string | undefined): boolean {
  const l = level?.toLowerCase()
  return l === "error" || l === "fatal" || l === "panic" || l === "dpanic"
}

/** Parses the single JSON value a command printed on stdout. */
function parseJson<T>(
  result: CliResult,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
  const text = result.stdout.trim()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Some commands print status events before the result; take the last
    // JSON line that is not a status event.
    json = undefined
    for (const line of text.split(/\r?\n/)) {
      try {
        const value = JSON.parse(line) as { kind?: unknown }
        if (value && value.kind !== "status") json = value
      } catch {
        // diagnostic line
      }
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success)
    throw new DevsyError(
      `Unexpected output from devsy: ${parsed.error.issues[0]?.message ?? "invalid JSON"}`,
      result.code,
    )
  return parsed.data
}

export interface UpArgs {
  /** Git URL (optionally `url@branch`) for a new workspace, or a workspace id. */
  source: string
  id?: string
  displayName?: string
  ide?: string
  ideLaunch?: "auto" | "headless" | "skip"
  recreate?: boolean
  sshConfigPath?: string
  /**
   * --clone-into-volume (our Devsy fork): clone into a Docker volume instead of
   * a host folder. Decided at creation; Devsy ignores it (with a warning) for
   * an existing workspace.
   */
  cloneIntoVolume?: boolean
}

export interface FollowCallbacks {
  onEnvelope(envelope: Envelope, stream: CliStream): void
  onLog(record: LogRecord): void
  onText(text: string, stream: CliStream): void
}

/** Typed Devsy commands. All JSON output is validated with zod. */
export class DevsyClient {
  constructor(readonly cli: DevsyCli) {}

  private async run(args: string[], timeoutMs?: number): Promise<CliResult> {
    const result = await this.cli.exec(args, { timeoutMs })
    if (result.code !== 0)
      throw errorFromResult(
        result,
        `devsy ${args.slice(0, 2).join(" ")} failed`,
      )
    return result
  }

  async version(): Promise<string> {
    const result = await this.cli.exec(["--version"], { protocolFlags: false })
    return result.stdout.trim().split(/\r?\n/).at(-1) ?? ""
  }

  async listWorkspaces(): Promise<WorkspaceListEntry[]> {
    return parseJson(
      await this.run(["workspace", "list", "--skip-platform"], 30_000),
      WorkspaceListSchema,
    )
  }

  /** null when the workspace does not exist. */
  async status(id: string): Promise<WorkspaceStatus | null> {
    const result = await this.cli.exec(
      ["workspace", "status", id, "--timeout", "15s"],
      { timeoutMs: 30_000 },
    )
    if (result.code === EXIT_NOT_FOUND) return null
    if (result.code !== 0)
      throw errorFromResult(result, `devsy workspace status ${id} failed`)
    return parseJson(result, WorkspaceStatusSchema)
  }

  async submitUp(args: UpArgs): Promise<TaskEnvelope> {
    const cliArgs = ["workspace", "up", args.source]
    if (args.id) cliArgs.push("--id", args.id)
    if (args.displayName) cliArgs.push("--display-name", args.displayName)
    if (args.ide) cliArgs.push("--ide", args.ide)
    if (args.ideLaunch) cliArgs.push("--ide-launch", args.ideLaunch)
    if (args.recreate) cliArgs.push("--recreate")
    if (args.sshConfigPath) cliArgs.push("--ssh-config", args.sshConfigPath)
    if (args.cloneIntoVolume) cliArgs.push("--clone-into-volume")
    cliArgs.push("--detach")
    return parseJson(await this.run(cliArgs, 60_000), TaskEnvelopeSchema)
  }

  /** Follows a detached task until it finishes. */
  followTask(taskId: string, callbacks: FollowCallbacks): StreamHandle {
    return this.streamEnvelopes(
      ["workspace", "task", "logs", taskId, "--follow"],
      callbacks,
      false,
    )
  }

  async listTasks(): Promise<TaskRecord[]> {
    return parseJson(
      await this.run(["workspace", "task", "list"]),
      TaskListSchema,
    )
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.run(["workspace", "task", "cancel", taskId], 30_000)
  }

  /** `workspace stop` (not detached): status events stream on stdout. */
  stop(id: string, callbacks: FollowCallbacks): StreamHandle {
    return this.streamEnvelopes(["workspace", "stop", id], callbacks, true)
  }

  /** `workspace delete` (not detached). */
  delete(id: string, callbacks: FollowCallbacks): StreamHandle {
    return this.streamEnvelopes(["workspace", "delete", id], callbacks, true)
  }

  async setIde(id: string, ide: string): Promise<void> {
    await this.run(["workspace", "set-ide", id, ide])
  }

  /**
   * One page of a run's setup history (lifecycle hook and image build
   * output). `after` is the previous page's nextCursor.
   */
  async readSetupLog(
    id: string,
    runId = "latest",
    after?: string,
  ): Promise<SetupLogRead> {
    const args = ["workspace", "logs", id, "--source", "setup", "--run", runId]
    if (after) args.push("--after", after)
    return parseJson(await this.run(args, 30_000), SetupLogReadSchema)
  }

  async providerNames(): Promise<string[]> {
    return Object.keys(
      parseJson(await this.run(["provider", "list"]), ProviderListSchema),
    )
  }

  async addProvider(name: string): Promise<void> {
    await this.run(["provider", "add", name, "--use=false"], 120_000)
  }

  async initProvider(name: string): Promise<void> {
    await this.run(["provider", "init", name], 120_000)
  }

  async useProvider(name: string): Promise<void> {
    await this.run(["provider", "use", name])
  }

  private streamEnvelopes(
    args: string[],
    callbacks: FollowCallbacks,
    resultFormat: boolean,
  ): StreamHandle {
    return this.cli.stream(
      args,
      (line, stream) => dispatchLine(parseLine(line), stream, callbacks),
      { resultFormat },
    )
  }
}

function dispatchLine(
  parsed: ParsedLine | undefined,
  stream: CliStream,
  callbacks: FollowCallbacks,
): void {
  if (!parsed) return
  if (parsed.type === "envelope") callbacks.onEnvelope(parsed.envelope, stream)
  else if (parsed.type === "log") callbacks.onLog(parsed.record)
  else callbacks.onText(parsed.text, stream)
}

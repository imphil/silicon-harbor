/*
 * Devsy CLI process runner.
 *
 * Portions derived from devsy-org/devsy desktop/src/main/cli.ts
 * (Mozilla Public License 2.0, https://mozilla.org/MPL/2.0/): the protocol
 * flags, line-based streaming via readline and the SIGTERM → SIGKILL
 * cancellation. This file is therefore also available under the MPL-2.0.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"

export type CliStream = "stdout" | "stderr"

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  /** Append `--result-format json` (default true). `task logs` does not take it. */
  resultFormat?: boolean
  /**
   * Append the protocol flags at all (default true). `devsy --version` only
   * works bare: with `--log-level info` it fails with `unknown command "info"`.
   */
  protocolFlags?: boolean
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number
}

export interface StreamHandle {
  /** Terminates the process (SIGTERM, then SIGKILL after 2 s). */
  cancel(): void
  /** Resolves with the exit code once the process has exited and all lines were delivered. */
  done: Promise<number>
}

/**
 * Everything the rest of the app needs from the CLI. Implemented by
 * CliRunner; tests replace it with a fixture-backed fake.
 */
export interface DevsyCli {
  /** Runs a command to completion. Never rejects on a non-zero exit code. */
  exec(args: string[], options?: ExecOptions): Promise<CliResult>
  /** Runs a command and delivers every output line as it arrives. */
  stream(
    args: string[],
    onLine: (line: string, stream: CliStream) => void,
    options?: ExecOptions,
  ): StreamHandle
}

export interface CliRunnerOptions {
  /** Path to the devsy binary (or a .mjs/.js script, run with `nodePath`). */
  binaryPath: string
  env: NodeJS.ProcessEnv
  logLevel?: "debug" | "info" | "warn" | "error"
  /** Interpreter for script binaries (tests). Defaults to process.execPath. */
  nodePath?: string
}

const KILL_GRACE_MS = 2000

export class CliRunner implements DevsyCli {
  private readonly command: string
  private readonly prefixArgs: string[]
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly options: CliRunnerOptions) {
    if (/\.[cm]?js$/.test(options.binaryPath)) {
      this.command = options.nodePath ?? process.execPath
      this.prefixArgs = [options.binaryPath]
    } else {
      this.command = options.binaryPath
      this.prefixArgs = []
    }
  }

  get binaryPath(): string {
    return this.options.binaryPath
  }

  /** The full argument list including the protocol flags. */
  protocolArgs(args: string[], options: ExecOptions = {}): string[] {
    if (options.protocolFlags === false) return [...args]
    const has = (flag: string) =>
      args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
    const full = [...args]
    if (!has("--log-level"))
      full.push("--log-level", this.options.logLevel ?? "info")
    if (!has("--log-output")) full.push("--log-output", "json")
    if ((options.resultFormat ?? true) && !has("--result-format"))
      full.push("--result-format", "json")
    return full
  }

  exec(args: string[], options: ExecOptions = {}): Promise<CliResult> {
    let stdout = ""
    let stderr = ""
    const handle = this.stream(
      args,
      (line, stream) => {
        if (stream === "stdout") stdout += `${line}\n`
        else stderr += `${line}\n`
      },
      options,
    )
    return handle.done.then((code) => ({ code, stdout, stderr }))
  }

  stream(
    args: string[],
    onLine: (line: string, stream: CliStream) => void,
    options: ExecOptions = {},
  ): StreamHandle {
    const child = spawn(
      this.command,
      [...this.prefixArgs, ...this.protocolArgs(args, options)],
      { env: this.options.env, windowsHide: true },
    )
    this.children.add(child)

    let killTimer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL")
      }, KILL_GRACE_MS)
    }

    const timeout =
      options.timeoutMs !== undefined
        ? setTimeout(cancel, options.timeoutMs)
        : undefined

    const closed = (stream: NodeJS.ReadableStream | null, name: CliStream) =>
      new Promise<void>((resolve) => {
        if (!stream) return resolve()
        const rl = createInterface({ input: stream, crlfDelay: Infinity })
        rl.on("line", (line) => onLine(stripAnsi(line), name))
        rl.on("close", () => resolve())
      })
    const outputs = Promise.all([
      closed(child.stdout, "stdout"),
      closed(child.stderr, "stderr"),
    ])

    const exited = new Promise<number>((resolve) => {
      // A spawn failure (missing binary, EACCES) emits "error" and may never
      // emit "close"; report it as a failed run instead of hanging.
      child.on("error", (error) => {
        onLine(
          JSON.stringify({
            kind: "error",
            outcome: "error",
            code: "spawn_failed",
            message: error.message,
          }),
          "stderr",
        )
        resolve(-1)
      })
      child.on("close", (code) => resolve(code ?? -1))
    })

    // Wait for the remaining buffered lines, but never hang on a stream that
    // does not close (e.g. after a spawn failure).
    const drained = exited.then((code) =>
      Promise.race([
        outputs,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]).then(() => code),
    )
    const done = drained.then((code) => {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      this.children.delete(child)
      return code
    })

    return { cancel, done }
  }

  /** Terminates every running child (app shutdown). */
  killAll(): void {
    for (const child of this.children) child.kill("SIGTERM")
  }
}

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use control characters by definition
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
}

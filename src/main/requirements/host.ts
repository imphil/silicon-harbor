import { spawn } from "node:child_process"
import { constants } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { elevatedCommand } from "./elevate"

/**
 * Everything the requirement checks and fixes need from the machine. All
 * external commands and file access go through this interface so every check
 * and fix can be unit-tested with a fake (src/main/__tests__/requirements*).
 */

export interface RunResult {
  /** Exit code; null when the process could not be started or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** True when the executable does not exist. */
  notFound?: boolean
  /** True when it was killed after timeoutMs. */
  timedOut?: boolean
}

export interface RunOptions {
  timeoutMs?: number
  /** Extra environment variables on top of the host environment. */
  env?: Record<string, string>
  /**
   * Log only the command and its outcome, not its output (it holds personal
   * data such as an account's name and email address).
   */
  quiet?: boolean
}

/** A process started with Host.start, still running. */
export interface StartedProcess {
  /** Resolves with the exit code (null when it could not start or was killed). */
  done: Promise<number | null>
  kill(): void
}

export interface StartOptions {
  /** Every output line, as it arrives. Never logged here. */
  onLine(line: string, stream: "stdout" | "stderr"): void
  /** Written to stdin, which is then closed; without it stdin is closed at once. */
  input?: string
}

export interface Host {
  platform: NodeJS.Platform
  arch: string
  homeDir: string
  userName: string
  env: NodeJS.ProcessEnv

  /** Runs a command; never throws for a non-zero exit. */
  run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>
  /** Runs a command with administrator rights (osascript / UAC / pkexec). */
  runElevated(cmd: string, args: string[]): Promise<RunResult>
  /** Finds an executable on PATH (honours PATHEXT on Windows). */
  which(name: string, extraDirs?: string[]): Promise<string | null>
  exists(path: string): Promise<boolean>
  /** File content, or null when missing/unreadable. */
  readText(path: string): Promise<string | null>
  /** Writes via a temp file + rename, creating parent directories. */
  writeTextAtomic(path: string, content: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
  makeExecutable(path: string): Promise<void>
  mkdirp(path: string): Promise<void>
  /** A fresh temporary directory. */
  tempDir(prefix: string): Promise<string>
  remove(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  /**
   * Starts a long-running command whose output is needed while it runs, such
   * as `gh auth login --web` printing its one-time code. No time limit; stdin
   * gets options.input or nothing, so the command knows nobody can type.
   */
  start(cmd: string, args: string[], options: StartOptions): StartedProcess
}

const MAX_OUTPUT = 1024 * 1024

/**
 * Decodes command output. Windows tools such as `wsl.exe` write UTF-16LE;
 * detect that by the NUL bytes it produces for ASCII text.
 */
export function decodeOutput(buffer: Buffer): string {
  if (buffer.length >= 2) {
    let nuls = 0
    const sample = Math.min(buffer.length, 200)
    for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) nuls++
    if (nuls > sample / 4) {
      const start =
        buffer[0] === 0xff && buffer[1] === 0xfe ? 2 : 0 /* UTF-16LE BOM */
      return buffer.subarray(start).toString("utf16le")
    }
  }
  return buffer.toString("utf8")
}

/** How long to wait for the rest of the output after a process exited. */
const OUTPUT_GRACE_MS = 2_000

export interface NodeHostOptions {
  openExternal(url: string): Promise<void>
  /** Receives one entry per command run (the setup log). */
  log?(entry: string): void
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  homeDir: string
  userName: string
}

export class NodeHost implements Host {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly homeDir: string
  readonly userName: string
  readonly env: NodeJS.ProcessEnv

  constructor(private readonly options: NodeHostOptions) {
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.homeDir = options.homeDir
    this.userName = options.userName
    this.env = options.env ?? process.env
  }

  run(cmd: string, args: string[], options: RunOptions = {}) {
    const started = Date.now()
    return this.spawnCollect(cmd, args, options).then((result) => {
      const logged = options.quiet
        ? { ...result, stdout: "", stderr: "" }
        : result
      this.options.log?.(formatRun(cmd, args, logged, Date.now() - started))
      return result
    })
  }

  /**
   * Resolves when the process exits, not when its output pipes close: a
   * process may start another one that inherits the pipes and keeps running
   * (`rdctl start` launches the Rancher Desktop app), which would otherwise
   * keep us waiting forever. timeoutMs is a hard limit either way.
   */
  private spawnCollect(cmd: string, args: string[], options: RunOptions) {
    return new Promise<RunResult>((resolve) => {
      // Windows .cmd/.bat shims (code.cmd) cannot be spawned without a shell.
      const shell = this.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)
      const child = spawn(shell ? `"${cmd}"` : cmd, args, {
        env: { ...this.env, ...options.env },
        shell,
        windowsHide: true,
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_OUTPUT) into.push(chunk)
      }
      child.stdout?.on("data", collect(out))
      child.stderr?.on("data", collect(err))

      let settled = false
      let timedOut = false
      let grace: NodeJS.Timeout | undefined
      const finish = (result: RunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(grace)
        // Whoever else holds the pipes may keep them; we stop listening.
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve(result)
      }
      const collected = (code: number | null): RunResult => ({
        code: timedOut ? null : code,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(err)),
        ...(timedOut ? { timedOut } : {}),
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        // Don't rely on exit/close after a kill either.
        grace = setTimeout(() => finish(collected(null)), OUTPUT_GRACE_MS)
      }, options.timeoutMs ?? 30_000)
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          code: null,
          stdout: "",
          stderr: error.message,
          notFound: error.code === "ENOENT",
        })
      })
      child.on("exit", (code) => {
        clearTimeout(grace)
        grace = setTimeout(() => finish(collected(code)), OUTPUT_GRACE_MS)
      })
      child.on("close", (code) => finish(collected(code)))
    })
  }

  runElevated(cmd: string, args: string[]) {
    const elevated = elevatedCommand(this.platform, cmd, args)
    // Installers can take minutes (Rancher Desktop, WSL).
    return this.run(elevated.command, elevated.args, { timeoutMs: 30 * 60_000 })
  }

  async which(name: string, extraDirs: string[] = []): Promise<string | null> {
    const pathVar =
      Object.entries(this.env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ??
      ""
    const dirs = [...extraDirs, ...pathVar.split(delimiter)].filter(Boolean)
    const names =
      this.platform === "win32"
        ? windowsExecutableNames(name, this.env.PATHEXT)
        : [name]
    for (const dir of dirs) {
      for (const file of names) {
        const candidate = join(dir, file)
        try {
          await access(
            candidate,
            this.platform === "win32" ? constants.F_OK : constants.X_OK,
          )
          return candidate
        } catch {
          // keep looking
        }
      }
    }
    return null
  }

  start(cmd: string, args: string[], options: StartOptions): StartedProcess {
    const started = Date.now()
    this.options.log?.(`$ ${[cmd, ...args].map(quoteArg).join(" ")} (started)`)
    const child = spawn(cmd, args, {
      env: this.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(options.input)
    }
    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      if (!stream) continue
      createInterface({ input: stream, crlfDelay: Infinity }).on(
        "line",
        (line) => options.onLine(stripControl(line), name),
      )
    }
    const done = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null))
      child.once("close", (code) => resolve(code))
    }).then((code) => {
      this.options.log?.(
        `$ ${cmd} … → exit ${code} (${Date.now() - started} ms)`,
      )
      return code
    })
    return {
      done,
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      },
    }
  }

  async exists(path: string) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  async readText(path: string) {
    try {
      return await readFile(path, "utf8")
    } catch {
      return null
    }
  }

  async writeTextAtomic(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.sh-tmp-${process.pid}`
    await writeFile(tmp, content, { mode: 0o600 })
    await rename(tmp, path)
  }

  async copyFile(src: string, dest: string) {
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
  }

  async makeExecutable(path: string) {
    if (this.platform !== "win32") await chmod(path, 0o755)
  }

  async mkdirp(path: string) {
    await mkdir(path, { recursive: true })
  }

  tempDir(prefix: string) {
    return mkdtemp(join(tmpdir(), prefix))
  }

  async remove(path: string) {
    await rm(path, { recursive: true, force: true })
  }

  openExternal(url: string) {
    return this.options.openExternal(url)
  }
}

const LOG_OUTPUT_LINES = 15

/** One setup-log entry: command, outcome, duration and the end of the output. */
/** Strips ANSI escape sequences (gh colours its output when it can). */
function stripControl(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use control characters by definition
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
}

export function formatRun(
  cmd: string,
  args: string[],
  result: RunResult,
  ms: number,
): string {
  const outcome = result.notFound
    ? "not found"
    : result.timedOut
      ? "timed out"
      : `exit ${result.code}`
  const lines = [
    `$ ${[cmd, ...args].map(quoteArg).join(" ")} → ${outcome} (${ms} ms)`,
  ]
  for (const [name, text] of [
    ["stdout", result.stdout],
    ["stderr", result.stderr],
  ] as const) {
    const tail = text
      .trimEnd()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-LOG_OUTPUT_LINES)
    for (const line of tail) lines.push(`  ${name}: ${line.slice(0, 500)}`)
  }
  return lines.join("\n")
}

function quoteArg(arg: string): string {
  const oneLine = arg.length > 200 ? `${arg.slice(0, 200)}…` : arg
  return /[\s"]/.test(oneLine)
    ? JSON.stringify(oneLine.replace(/\r?\n/g, " ⏎ "))
    : oneLine
}

/**
 * File names Windows would run for a command name: the name with each
 * PATHEXT extension, or the name itself if it already has one. Never the
 * bare name otherwise: VS Code-style IDEs ship an extensionless shell script
 * (for Git Bash) next to `code.cmd`, which Windows cannot run.
 */
export function windowsExecutableNames(
  name: string,
  pathext = ".EXE;.CMD;.BAT",
): string[] {
  const exts = pathext
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."))
  const lower = name.toLowerCase()
  if (exts.some((e) => lower.endsWith(e))) return [name]
  return exts.map((e) => name + e)
}

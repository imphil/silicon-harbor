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
}

export interface RunOptions {
  timeoutMs?: number
  /** Extra environment variables on top of the host environment. */
  env?: Record<string, string>
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

export interface NodeHostOptions {
  openExternal(url: string): Promise<void>
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
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000)
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve({
          code: null,
          stdout: "",
          stderr: error.message,
          notFound: error.code === "ENOENT",
        })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({
          code,
          stdout: decodeOutput(Buffer.concat(out)),
          stderr: decodeOutput(Buffer.concat(err)),
        })
      })
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
    const exts =
      this.platform === "win32"
        ? ["", ...(this.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
        : [""]
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext.toLowerCase())
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

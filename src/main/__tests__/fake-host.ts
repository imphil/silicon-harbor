import type { Settings } from "../../shared/api"
import { loadManifest, type Manifest } from "../installers/manifest"
import type { Host, RunOptions, RunResult } from "../requirements/host"
import type { Pending, RequirementContext } from "../requirements/types"

/**
 * A scripted Host for requirement tests: command results by "cmd arg1 arg2",
 * files, executables on PATH. Records every elevated call, write and opened
 * URL. Nothing touches the real machine.
 */

type Responder = RunResult | ((args: string[]) => RunResult)

export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })
export const fail = (stderr = "", code = 1): RunResult => ({
  code,
  stdout: "",
  stderr,
})
export const notFound: RunResult = {
  code: null,
  stdout: "",
  stderr: "ENOENT",
  notFound: true,
}

export interface FakeHostInit {
  platform: NodeJS.Platform
  arch?: string
  homeDir?: string
  userName?: string
  env?: NodeJS.ProcessEnv
  /** "cmd arg1 arg2" → result; exact match first, then the command alone. */
  commands?: Record<string, Responder>
  /** Elevated commands by the same key; default: success. */
  elevated?: Record<string, Responder>
  /** name → path for which() */
  path?: Record<string, string>
  files?: Record<string, string>
  dirs?: string[]
}

export class FakeHost implements Host {
  platform: NodeJS.Platform
  arch: string
  homeDir: string
  userName: string
  env: NodeJS.ProcessEnv
  commands: Record<string, Responder>
  elevatedResponses: Record<string, Responder>
  path: Record<string, string>
  files: Record<string, string>
  dirs: Set<string>

  runs: string[] = []
  elevatedRuns: string[] = []
  writes: Array<{ path: string; content: string }> = []
  copies: Array<{ src: string; dest: string }> = []
  opened: string[] = []
  removed: string[] = []
  private tempCount = 0

  constructor(init: FakeHostInit) {
    this.platform = init.platform
    this.arch = init.arch ?? (init.platform === "darwin" ? "arm64" : "x64")
    this.homeDir =
      init.homeDir ??
      (init.platform === "win32"
        ? "C:\\Users\\dev"
        : init.platform === "darwin"
          ? "/Users/dev"
          : "/home/dev")
    this.userName = init.userName ?? "dev"
    this.env = init.env ?? {}
    this.commands = init.commands ?? {}
    this.elevatedResponses = init.elevated ?? {}
    this.path = init.path ?? {}
    this.files = { ...init.files }
    this.dirs = new Set(init.dirs)
  }

  private respond(
    table: Record<string, Responder>,
    cmd: string,
    args: string[],
    fallback: RunResult,
  ): RunResult {
    const key = [cmd, ...args].join(" ")
    const responder = table[key] ?? table[cmd]
    if (responder === undefined) return fallback
    return typeof responder === "function" ? responder(args) : responder
  }

  async run(cmd: string, args: string[], _options?: RunOptions) {
    this.runs.push([cmd, ...args].join(" "))
    return this.respond(this.commands, cmd, args, notFound)
  }

  async runElevated(cmd: string, args: string[]) {
    this.elevatedRuns.push([cmd, ...args].join(" "))
    return this.respond(this.elevatedResponses, cmd, args, ok())
  }

  async which(name: string, extraDirs: string[] = []) {
    if (this.path[name]) return this.path[name]
    for (const dir of extraDirs) {
      const sep = this.platform === "win32" ? "\\" : "/"
      for (const candidate of [
        `${dir}${sep}${name}`,
        `${dir}${sep}${name}.exe`,
      ]) {
        if (candidate in this.files || this.dirs.has(candidate))
          return candidate
      }
    }
    return null
  }

  async exists(path: string) {
    return path in this.files || this.dirs.has(path)
  }

  async readText(path: string) {
    return this.files[path] ?? null
  }

  async writeTextAtomic(path: string, content: string) {
    this.writes.push({ path, content })
    this.files[path] = content
  }

  async copyFile(src: string, dest: string) {
    this.copies.push({ src, dest })
    this.files[dest] = this.files[src] ?? "binary"
  }

  async makeExecutable() {}
  async mkdirp(path: string) {
    this.dirs.add(path)
  }

  async tempDir(prefix: string) {
    const dir = `/tmp/${prefix}${++this.tempCount}`
    this.dirs.add(dir)
    return dir
  }

  async remove(path: string) {
    this.removed.push(path)
  }

  async openExternal(url: string) {
    this.opened.push(url)
  }
}

export interface FakeContext extends RequirementContext {
  installs: Array<{ id: string; binaryDest?: string }>
  progressLog: string[]
  resolved: boolean
}

export function fakeContext(
  host: FakeHost,
  options: {
    settings?: Partial<Settings>
    pending?: Pending
    manifest?: Manifest
    binDir?: string
    /** Side effect of an install, e.g. making the app appear. */
    onInstall?: (id: string, binaryDest?: string) => void
  } = {},
): FakeContext {
  const installs: FakeContext["installs"] = []
  const progressLog: string[] = []
  const settings: Settings = {
    defaultIde: "bob",
    autoUpdateCheck: true,
    firstRunDone: true,
    ...options.settings,
  }
  return {
    host,
    manifest: options.manifest ?? loadManifest(),
    binDir:
      options.binDir ??
      (host.platform === "win32"
        ? "C:\\Users\\dev\\.silicon-harbor\\bin"
        : `${host.homeDir}/.silicon-harbor/bin`),
    settings: () => ({ ...settings }),
    updateSettings: (patch) => {
      Object.assign(settings, patch)
    },
    pending: options.pending,
    progress: (detail) => progressLog.push(detail),
    resolved: false,
    resolvePending() {
      this.resolved = true
    },
    install: async (id, opts) => {
      installs.push({ id, binaryDest: opts?.binaryDest })
      options.onInstall?.(id, opts?.binaryDest)
    },
    sleep: async () => {},
    installs,
    progressLog,
  }
}

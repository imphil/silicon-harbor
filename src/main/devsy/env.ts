import { posix, win32 } from "node:path"

/**
 * Environment for Devsy CLI child processes.
 *
 * Devsy stores its complete process environment in task state
 * ($DEVSY_HOME/state/tasks/*.json) and returns it from `workspace task list`
 * (docs/developer/devsy/cli-contract.md §6). We therefore pass an allow-list only, never the
 * whole host environment.
 */

/** Variables passed through unchanged when present (matched case-insensitively). */
const ALLOWED = [
  // process basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Windows basics
  "USERPROFILE",
  "USERNAME",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "HOMEDRIVE",
  "HOMEPATH",
  // XDG (Linux)
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  // container engine
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // network
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  // display (X11 forwarding into environments) and SSH agent
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
]

const ALLOWED_SET = new Set(ALLOWED)

export interface CliEnvInput {
  /** Usually process.env. */
  hostEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** The user's home directory (os.homedir()). */
  homeDir: string
  /** DEVSY_HOME to use (see defaultDevsyHome). */
  devsyHome: string
  /** Extra variables, e.g. for tests. Applied last. */
  extra?: Record<string, string>
  /**
   * Directories put in front of PATH, e.g. our own bin dir with
   * docker-credential-icr (the docker CLI Devsy runs looks helpers up on PATH).
   */
  extraPathDirs?: string[]
}

export function buildCliEnv(input: CliEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input.hostEnv)) {
    if (value === undefined) continue
    if (ALLOWED_SET.has(key.toUpperCase())) env[key] = value
  }

  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  const searchPath = executableSearchPath(
    env[pathKey] ?? "",
    input.platform,
    input.homeDir,
  )
  const separator = input.platform === "win32" ? ";" : ":"
  env[pathKey] = [...(input.extraPathDirs ?? []), searchPath]
    .filter((part) => part !== "")
    .join(separator)

  // English, stable messages: our error catalog matches on them, and git's
  // messages are localized otherwise (docs/developer/devsy/cli-contract.md §5).
  env.LC_ALL = "C"
  env.LANG = "C"
  env.DEVSY_UI = "true"
  env.DEVSY_HOME = input.devsyHome
  return { ...env, ...input.extra }
}

/**
 * On macOS, GUI apps inherit a minimal PATH without Homebrew, user-local bin
 * directories or Rancher Desktop's ~/.rd/bin (where its docker CLI lives).
 *
 * Origin: devsy-org/devsy desktop/src/main/executable-path.ts (MPL-2.0),
 * extended with ~/.rd/bin.
 */
export function executableSearchPath(
  currentPath: string,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (platform !== "darwin") return currentPath

  const extraDirs = [
    posix.join(home, ".rd", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    posix.join(home, ".local", "bin"),
  ]
  return [...new Set([...extraDirs, ...currentPath.split(":")])]
    .filter((directory) => directory !== "")
    .join(":")
}

/**
 * Silicon Harbor's isolated Devsy home.
 *
 * Must stay short: Devsy creates unix sockets under $DEVSY_HOME/run/ and socket
 * paths are limited to 104 bytes, so Electron's userData directory
 * (~/Library/Application Support/…) is too long (docs/developer/devsy/cli-contract.md §6).
 */
export function defaultDevsyHome(
  platform: NodeJS.Platform,
  homeDir: string,
  hostEnv: NodeJS.ProcessEnv,
): string {
  const override = hostEnv.SH_DEVSY_HOME
  if (override) return override
  const join = platform === "win32" ? win32.join : posix.join
  return join(homeDir, ".silicon-harbor")
}

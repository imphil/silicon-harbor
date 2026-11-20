import type { GitHubAccount } from "../../shared/api"
import type { Host, StartedProcess } from "../requirements/host"

/**
 * The GitHub CLI (gh) is the GitHub sign-in on every platform: it holds the
 * token for GIT_HOST, is Git's credential helper for that host
 * (`gh auth setup-git`), and Devsy forwards its token into environments
 * (context option SSH_INJECT_GITHUB_CREDENTIALS) so Git and gh work there.
 */

/** The Git host Silicon Harbor's repositories live on. */
export const GIT_HOST = "github.ibm.com"

/** Where the gh installers put gh when it is not on PATH yet (a fresh install). */
export function ghExtraDirs(host: Host): string[] {
  switch (host.platform) {
    case "win32":
      return [
        `${host.env.ProgramFiles ?? host.env.PROGRAMFILES ?? "C:\\Program Files"}\\GitHub CLI`,
      ]
    case "darwin":
      return ["/usr/local/bin", "/opt/homebrew/bin"]
    default:
      return []
  }
}

/** Absolute path of gh, or null when it is not installed. */
export function findGh(host: Host): Promise<string | null> {
  return host.which("gh", ghExtraDirs(host))
}

function ghConfigDir(host: Host): string {
  if (host.env.GH_CONFIG_DIR) return host.env.GH_CONFIG_DIR
  if (host.platform === "win32") {
    const appData = host.env.AppData ?? host.env.APPDATA
    if (appData) return `${appData}\\GitHub CLI`
  }
  const xdg = host.env.XDG_CONFIG_HOME || `${host.homeDir}/.config`
  return `${xdg}/gh`
}

/**
 * gh lists every host it is signed in to in hosts.yml (the token itself is
 * in the keyring, or in that file). Reading the file, instead of running
 * `gh auth token`, keeps tokens out of the setup log and works offline.
 */
export async function ghSignedIn(host: Host): Promise<boolean> {
  const sep = host.platform === "win32" ? "\\" : "/"
  const hosts = await host.readText(`${ghConfigDir(host)}${sep}hosts.yml`)
  const escaped = GIT_HOST.replace(/\./g, "\\.")
  return hosts !== null && new RegExp(`^${escaped}:\\s*$`, "m").test(hosts)
}

/** gh is Git's credential helper for GIT_HOST (host-specific or global). */
export async function ghHelperConfigured(host: Host): Promise<boolean> {
  for (const key of [
    `credential.https://${GIT_HOST}.helper`,
    "credential.helper",
  ]) {
    const res = await host.run("git", ["config", "--get-all", key])
    if (
      res.code === 0 &&
      /\bgh(\.exe)?['"]?\s+auth\s+git-credential\b/.test(res.stdout)
    )
      return true
  }
  return false
}

/**
 * A url.<base>.insteadOf rule that rewrites https://GIT_HOST, e.g. to SSH.
 * Silicon Harbor clones over HTTPS, so such a rule breaks the sign-in.
 */
export async function httpsRewriteRule(
  host: Host,
): Promise<string | undefined> {
  const res = await host.run("git", [
    "config",
    "--get-regexp",
    "^url\\..*\\.insteadof$",
  ])
  if (res.code !== 0) return undefined
  for (const line of res.stdout.split(/\r?\n/)) {
    const space = line.indexOf(" ")
    if (space < 0) continue
    const value = line.slice(space + 1).trim()
    if (value.startsWith(`https://${GIT_HOST}`))
      return `${line.slice(0, space)} = ${value}`
  }
  return undefined
}

/** Makes gh Git's credential helper for GIT_HOST. */
export async function setupGit(host: Host, gh: string): Promise<void> {
  const res = await host.run(
    gh,
    ["auth", "setup-git", "--hostname", GIT_HOST],
    {
      timeoutMs: 30_000,
    },
  )
  if (res.code !== 0)
    throw new Error(
      `Could not set up Git to use the GitHub CLI: ${(res.stderr || res.stdout).trim()}`,
    )
}

// ---------------------------------------------------------------------------
// Sign-in

/** The one-time code and page of gh's browser sign-in (OAuth device flow). */
export interface DeviceCode {
  code: string
  url: string
}

/**
 * Reads gh's output without a terminal (internal/authflow/flow.go):
 *   ! First copy your one-time code: ABCD-1234
 *   Open this URL to continue in your web browser: https://…/login/device
 */
export function parseSignInLine(
  line: string,
): { code: string } | { url: string } | undefined {
  const code = /one-time code(?::|\s*\()\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(
    line,
  )
  if (code?.[1]) return { code: code[1] }
  const url = /continue in your web browser:\s*(https:\/\/\S+)/i.exec(line)
  if (url?.[1]) return { url: url[1] }
  return undefined
}

export interface GitHubSignInDeps {
  host: Host
  /** Puts the one-time code on the clipboard, ready to paste in the browser. */
  writeClipboard?(text: string): void
  /** The sign-in started, showed its code or ended. */
  onChange(): void
}

/**
 * `gh auth login --web` without a terminal: gh prints a one-time code and the
 * page to enter it on, then waits until the user confirms in the browser.
 * We open that page, copy the code and show it in the app. One sign-in at a
 * time: Settings › Credentials and the "This computer" fix share it.
 */
export class GitHubSignIn {
  private current?: {
    promise: Promise<void>
    process?: StartedProcess
    code?: string
    url?: string
    cancelled: boolean
  }

  constructor(private readonly deps: GitHubSignInDeps) {}

  /** The code to enter, once gh printed it. */
  get pending(): DeviceCode | undefined {
    const c = this.current
    return c?.code && c.url ? { code: c.code, url: c.url } : undefined
  }

  get active(): boolean {
    return this.current !== undefined
  }

  /** Signs in (or joins the sign-in in progress). Rejects when it fails. */
  run(): Promise<void> {
    if (this.current) return this.current.promise
    const state: NonNullable<GitHubSignIn["current"]> = {
      promise: Promise.resolve(),
      cancelled: false,
    }
    this.current = state
    state.promise = this.signIn(state).finally(() => {
      this.current = undefined
      this.deps.onChange()
    })
    this.deps.onChange()
    return state.promise
  }

  cancel(): void {
    const c = this.current
    if (!c) return
    c.cancelled = true
    c.process?.kill()
  }

  private async signIn(state: NonNullable<GitHubSignIn["current"]>) {
    const { host } = this.deps
    const gh = await findGh(host)
    if (!gh)
      throw new Error(
        "The GitHub CLI is not installed. Install it under Settings › This computer.",
      )
    if (state.cancelled) return
    const lines: string[] = []
    state.process = host.start(
      gh,
      [
        "auth",
        "login",
        "--hostname",
        GIT_HOST,
        "--git-protocol",
        "https",
        "--web",
      ],
      {
        onLine: (line) => {
          if (line.trim()) lines.push(line.trim())
          const found = parseSignInLine(line)
          if (!found) return
          const before = this.pending
          if ("code" in found) state.code = found.code
          else state.url = found.url
          const after = this.pending
          if (!before && after) {
            this.deps.writeClipboard?.(after.code)
            void host.openExternal(after.url)
            this.deps.onChange()
          }
        },
      },
    )
    const code = await state.process.done
    if (state.cancelled) return
    if (code !== 0) {
      const reason = lines.at(-1)
      throw new Error(
        `Signing in to ${GIT_HOST} did not finish${reason ? `: ${reason}` : "."}`,
      )
    }
    await setupGit(host, gh)
  }
}

// ---------------------------------------------------------------------------
// Account check

export type GitHubAccountCheck =
  | { kind: "ok"; account: GitHubAccount; scopes: string[] }
  | { kind: "signed-out" }
  | { kind: "invalid"; detail: string }
  | { kind: "unreachable"; detail: string }

/**
 * Asks GIT_HOST who the stored token belongs to (`gh api --include user`):
 * proves the token works and shows its account and scopes. Quiet, so the
 * account's name and email address stay out of the setup log.
 */
export async function checkGitHubAccount(
  host: Host,
  gh: string,
): Promise<GitHubAccountCheck> {
  const res = await host.run(
    gh,
    ["api", "--hostname", GIT_HOST, "--include", "user"],
    { timeoutMs: 20_000, quiet: true },
  )
  const errorText = `${res.stderr}\n${res.stdout}`
  if (res.code === 4 || /gh auth login/.test(res.stderr))
    return { kind: "signed-out" }
  if (/HTTP 401|Bad credentials/i.test(errorText))
    return {
      kind: "invalid",
      detail: `${GIT_HOST} no longer accepts the stored sign-in. Sign in again.`,
    }
  if (res.code !== 0) {
    const reason = res.timedOut
      ? "no answer within 20 seconds"
      : res.stderr.trim().split(/\r?\n/).at(-1) || `exit ${res.code}`
    return {
      kind: "unreachable",
      detail: `Could not reach ${GIT_HOST} (${reason}).`,
    }
  }
  const parsed = parseApiResponse(res.stdout)
  if (!parsed?.login)
    return {
      kind: "unreachable",
      detail: `Unexpected answer from ${GIT_HOST}.`,
    }
  return {
    kind: "ok",
    account: {
      login: parsed.login,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.email ? { email: parsed.email } : {}),
    },
    scopes: parsed.scopes,
  }
}

/** Headers (`--include`) followed by the JSON body of GET /user. */
export function parseApiResponse(
  text: string,
): { login?: string; name?: string; email?: string; scopes: string[] } | null {
  const split = /\r?\n\r?\n/.exec(text)
  if (!split) return null
  const headers = text.slice(0, split.index)
  const body = text.slice(split.index + split[0].length)
  const scopeHeader = /^x-oauth-scopes:\s*(.*)$/im.exec(headers)?.[1] ?? ""
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const user = JSON.parse(body) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
    return {
      login: str(user.login),
      name: str(user.name),
      email: str(user.email),
      scopes,
    }
  } catch {
    return null
  }
}

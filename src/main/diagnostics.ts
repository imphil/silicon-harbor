import type { AppInfo, Environment, LogLine } from "../shared/api"

export interface DiagnosticsInput {
  app: AppInfo
  devsyVersion: string
  devsyHome: string
  homeDir: string
  userName?: string
  environments: Environment[]
  /** Log of the environment the bundle is for, if any. */
  focus?: { id: string; log: LogLine[] }
  /** Last lines of the setup log (requirement checks and fixes). */
  setupLog?: string[]
}

const MAX_LOG_LINES = 300

/**
 * Plain-text diagnostics for support. Contains no environment variables and no
 * Devsy task data (which would include the host environment); paths under the
 * user's home are shortened to "~" and the user name is replaced.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [
    "Silicon Harbor diagnostics",
    `Generated: ${new Date().toISOString()}`,
    "",
    `App: ${input.app.appVersion} (Electron ${input.app.electronVersion})`,
    `Platform: ${input.app.platform} ${input.app.arch}`,
    `Devsy: ${input.devsyVersion || "unknown"}${input.app.devsyPath ? "" : " (binary missing)"}`,
    `Devsy home: ${input.devsyHome}`,
    "",
    `Environments (${input.environments.length}):`,
  ]
  for (const env of input.environments) {
    const op = env.operation
    lines.push(
      `- ${env.id}: ${env.state}, ide=${env.ide}, repo=${env.repoUrl}${env.branch ? `@${env.branch}` : ""}`,
    )
    if (op) {
      lines.push(
        `    last operation: ${op.kind} ${op.state} (${op.startedAt}${op.finishedAt ? ` → ${op.finishedAt}` : ""})`,
      )
      lines.push(
        `    steps: ${op.steps.map((s) => `${s.id}=${s.state}`).join(" ")}`,
      )
      if (op.error)
        lines.push(
          `    error: ${op.error.code}${op.error.cliCode ? ` [${op.error.cliCode}]` : ""}: ${op.error.title}`,
        )
    }
  }
  if (input.focus) {
    lines.push("", `Log of ${input.focus.id} (last ${MAX_LOG_LINES} lines):`)
    for (const l of input.focus.log.slice(-MAX_LOG_LINES))
      lines.push(`${l.ts} ${l.level.toUpperCase().padEnd(5)} ${l.text}`)
  }
  if (input.setupLog?.length) {
    lines.push("", `Setup log (last ${input.setupLog.length} lines):`)
    lines.push(...input.setupLog)
  }
  return redact(lines.join("\n"), input.homeDir, input.userName)
}

export function redact(
  text: string,
  homeDir: string,
  userName?: string,
): string {
  let out = text
  if (homeDir) out = out.split(homeDir).join("~")
  if (userName && userName.length >= 3)
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(userName)}\\b`, "g"),
      "<user>",
    )
  // Credentials that may appear in URLs or messages.
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1<redacted>@")
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "<redacted-token>")
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

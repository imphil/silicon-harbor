import { spawn } from "node:child_process"

/**
 * "Open terminal": the OS terminal running `devsy workspace ssh <id>`.
 * No embedded terminal (no native modules, PLAN.md §1).
 */

export interface TerminalCommand {
  command: string
  args: string[]
}

export interface TerminalInput {
  platform: NodeJS.Platform
  devsyPath: string
  devsyHome: string
  workspaceId: string
  /** $TERMINAL on Linux, if set. */
  preferredTerminal?: string
}

/** Single-quotes a string for POSIX shells. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escapes a string for an AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Candidate commands, in order of preference. */
export function terminalCommands(input: TerminalInput): TerminalCommand[] {
  const sshArgs = [
    "workspace",
    "ssh",
    input.workspaceId,
    "--home",
    input.devsyHome,
  ]

  if (input.platform === "darwin") {
    const shell = [input.devsyPath, ...sshArgs].map(shQuote).join(" ")
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script ${appleScriptString(shell)}`,
          "-e",
          'tell application "Terminal" to activate',
        ],
      },
    ]
  }

  if (input.platform === "win32") {
    return [
      {
        command: "wt.exe",
        args: [
          "new-tab",
          "--title",
          input.workspaceId,
          input.devsyPath,
          ...sshArgs,
        ],
      },
      {
        command: "cmd.exe",
        args: [
          "/c",
          "start",
          `"${input.workspaceId}"`,
          `"${input.devsyPath}"`,
          ...sshArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)),
        ],
      },
    ]
  }

  const argv = [input.devsyPath, ...sshArgs]
  const candidates: TerminalCommand[] = []
  if (input.preferredTerminal)
    candidates.push({ command: input.preferredTerminal, args: ["-e", ...argv] })
  candidates.push(
    // Fedora's default terminal since Fedora 41
    { command: "ptyxis", args: ["--new-window", "--", ...argv] },
    { command: "gnome-terminal", args: ["--", ...argv] },
    { command: "konsole", args: ["-e", ...argv] },
    { command: "x-terminal-emulator", args: ["-e", ...argv] },
    { command: "xterm", args: ["-e", ...argv] },
  )
  return candidates
}

/** Starts the first candidate that exists. */
export async function openTerminal(input: TerminalInput): Promise<void> {
  const tried: string[] = []
  for (const candidate of terminalCommands(input)) {
    tried.push(candidate.command)
    const started = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate.command, candidate.args, {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: candidate.command === "cmd.exe",
      })
      child.once("error", () => resolve(false))
      child.once("spawn", () => {
        child.unref()
        resolve(true)
      })
    })
    if (started) return
  }
  throw new Error(`No terminal application found (tried ${tried.join(", ")})`)
}

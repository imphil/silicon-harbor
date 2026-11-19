/**
 * Builds the command that runs `cmd args…` with administrator rights, using
 * the normal OS prompt (PLAN.md §1: users have admin rights; no own helper).
 *
 * - macOS: AppleScript `do shell script … with administrator privileges`
 * - Windows: PowerShell `Start-Process -Verb RunAs -Wait` (UAC), propagating
 *   the exit code
 * - Linux: pkexec (polkit)
 */
export interface ElevatedCommand {
  command: string
  args: string[]
}

/** Single-quotes a string for POSIX shells. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escapes a string for an AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Single-quotes a string for PowerShell. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Quotes one argument for a Windows command line (CommandLineToArgvW rules),
 * as Start-Process passes ArgumentList through verbatim.
 */
export function windowsArg(value: string): string {
  if (value !== "" && !/[\s"]/.test(value)) return value
  let out = '"'
  let backslashes = 0
  for (const ch of value) {
    if (ch === "\\") {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`
    } else {
      out += "\\".repeat(backslashes) + ch
    }
    backslashes = 0
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`
}

export function elevatedCommand(
  platform: NodeJS.Platform,
  cmd: string,
  args: string[],
): ElevatedCommand {
  if (platform === "darwin") {
    const shell = [cmd, ...args].map(shellQuote).join(" ")
    return {
      command: "osascript",
      args: [
        "-e",
        `do shell script ${appleScriptString(shell)} with administrator privileges`,
      ],
    }
  }

  if (platform === "win32") {
    const argumentList = args.map(windowsArg).join(" ")
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$p = Start-Process -FilePath ${psQuote(cmd)}` +
        (argumentList ? ` -ArgumentList ${psQuote(argumentList)}` : "") +
        " -Verb RunAs -Wait -PassThru",
      "exit $p.ExitCode",
    ].join("; ")
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    }
  }

  return { command: "pkexec", args: [cmd, ...args] }
}

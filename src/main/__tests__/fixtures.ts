import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  CliResult,
  CliStream,
  DevsyCli,
  ExecOptions,
  StreamHandle,
} from "../devsy/runner"

export const FIXTURE_DIR = fileURLToPath(
  new URL("../../../test/fixtures/devsy/", import.meta.url),
)

export interface Fixture {
  name: string
  stdout: string
  stderr: string
  code: number
}

/** Loads a recorded case from test/fixtures/devsy/<name>/. */
export function fixture(name: string): Fixture {
  const dir = join(FIXTURE_DIR, name)
  const read = (file: string) =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : ""
  return {
    name,
    stdout: read("stdout.ndjson"),
    stderr: read("stderr.ndjson"),
    code: Number(read("exit-code.txt").trim() || "0"),
  }
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "")
}

/** Parsed JSON lines of a fixture's stdout. */
export function stdoutJson<T = unknown>(name: string): T[] {
  return lines(fixture(name).stdout).map((l) => JSON.parse(l) as T)
}

export type Responder = (args: string[]) => Fixture | undefined

/**
 * A DevsyCli that answers with recorded fixtures. `respond` maps a command
 * (without protocol flags) to a fixture; unmatched commands fail loudly.
 * Streams deliver one line per macrotask so tests can observe progress.
 */
export class FixtureCli implements DevsyCli {
  readonly calls: string[][] = []
  readonly cancelled: string[][] = []

  constructor(private readonly respond: Responder) {}

  private answer(args: string[]): Fixture {
    this.calls.push(args)
    const f = this.respond(args)
    if (!f) throw new Error(`FixtureCli: unexpected command: ${args.join(" ")}`)
    return f
  }

  async exec(args: string[], _options?: ExecOptions): Promise<CliResult> {
    const f = this.answer(args)
    return { code: f.code, stdout: f.stdout, stderr: f.stderr }
  }

  stream(
    args: string[],
    onLine: (line: string, stream: CliStream) => void,
    _options?: ExecOptions,
  ): StreamHandle {
    const f = this.answer(args)
    const queue: Array<[string, CliStream]> = [
      ...lines(f.stdout).map((l) => [l, "stdout"] as [string, CliStream]),
      ...lines(f.stderr).map((l) => [l, "stderr"] as [string, CliStream]),
    ]
    let cancelled = false
    const done = (async () => {
      for (const [line, stream] of queue) {
        if (cancelled) return 143
        await new Promise((r) => setTimeout(r, 0))
        onLine(line, stream)
      }
      return f.code
    })()
    return {
      cancel: () => {
        cancelled = true
        this.cancelled.push(args)
      },
      done,
    }
  }
}

/** Waits until all queued timers/microtasks of the fake have run. */
export async function settle(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

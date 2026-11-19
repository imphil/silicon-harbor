import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { LogLine } from "../shared/api"
import { WORKSPACE_ID_PATTERN } from "./devsy/ids"

const MAX_LINES = 5000

/**
 * Per-environment operation logs: one JSON-lines file per environment under
 * <userData>/logs. Kept outside DEVSY_HOME, so `workspace delete` cannot remove
 * a file we are still writing.
 */
export class LogStore {
  private readonly cache = new Map<string, LogLine[]>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(id: string): string {
    if (!WORKSPACE_ID_PATTERN.test(id)) throw new Error(`invalid id ${id}`)
    return join(this.dir, `${id}.log`)
  }

  append(id: string, line: LogLine): void {
    const lines = this.read(id)
    lines.push(line)
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    try {
      appendFileSync(this.file(id), `${JSON.stringify(line)}\n`)
    } catch {
      // Logging must never break an operation.
    }
  }

  read(id: string): LogLine[] {
    const cached = this.cache.get(id)
    if (cached) return cached
    let lines: LogLine[] = []
    try {
      lines = readFileSync(this.file(id), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as LogLine]
          } catch {
            return []
          }
        })
        .slice(-MAX_LINES)
    } catch {
      // no log yet
    }
    this.cache.set(id, lines)
    return lines
  }

  remove(id: string): void {
    this.cache.delete(id)
    try {
      rmSync(this.file(id), { force: true })
    } catch {
      // ignore
    }
  }
}

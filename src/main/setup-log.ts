import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { dirname } from "node:path"

const MAX_BYTES = 1024 * 1024

/**
 * Plain-text log of what the requirement checks and fixes ran
 * (`<userData>/logs/setup.log`). Rotated to `setup.log.1` at 1 MB. Never
 * throws: logging must not break a check or fix.
 */
export class SetupLog {
  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(entry: string): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (this.size() > MAX_BYTES) renameSync(this.file, `${this.file}.1`)
      const ts = this.now().toISOString()
      appendFileSync(this.file, `${ts} ${entry.replace(/\n/g, "\n    ")}\n`)
    } catch {
      // ignore
    }
  }

  /** The last `lines` lines (current file only). */
  tail(lines: number): string[] {
    try {
      return readFileSync(this.file, "utf8").trimEnd().split("\n").slice(-lines)
    } catch {
      return []
    }
  }

  private size(): number {
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }
}

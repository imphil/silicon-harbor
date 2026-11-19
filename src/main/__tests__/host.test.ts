// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatRun, NodeHost } from "../requirements/host"
import { SetupLog } from "../setup-log"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sh-host-"))
  dirs.push(d)
  return d
}

const posixOnly = process.platform === "win32" ? it.skip : it

describe("NodeHost.run", () => {
  function host(log?: (e: string) => void) {
    return new NodeHost({
      homeDir: tmpdir(),
      userName: "",
      openExternal: async () => {},
      log,
    })
  }

  // Like `rdctl start`: it starts a long-running process that inherits the
  // output pipes, then exits. Waiting for the pipes to close would hang.
  posixOnly(
    "returns when the process exits, even if a child keeps its output open",
    async () => {
      const started = Date.now()
      const res = await host().run("sh", ["-c", "sleep 8 & echo started"], {
        timeoutMs: 20_000,
      })
      expect(res.code).toBe(0)
      expect(res.stdout.trim()).toBe("started")
      expect(Date.now() - started).toBeLessThan(6_000)
    },
    10_000,
  )

  posixOnly(
    "enforces the timeout even when the pipes stay open",
    async () => {
      const started = Date.now()
      const res = await host().run("sh", ["-c", "sleep 8 & exec sleep 30"], {
        timeoutMs: 300,
      })
      expect(res.timedOut).toBe(true)
      expect(res.code).toBeNull()
      expect(Date.now() - started).toBeLessThan(6_000)
    },
    10_000,
  )

  posixOnly("logs every command with its outcome", async () => {
    const entries: string[] = []
    await host((e) => entries.push(e)).run("sh", ["-c", "echo hi; exit 3"])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(
      /^\$ sh -c "echo hi; exit 3" → exit 3 \(\d+ ms\)\n {2}stdout: hi$/,
    )
  })

  it("reports a missing executable", async () => {
    const res = await host().run("sh-definitely-missing-4711", [])
    expect(res.notFound).toBe(true)
  })
})

describe("formatRun", () => {
  it("keeps the end of long output and shortens long arguments", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    const text = formatRun(
      "rdctl",
      ["start", "x".repeat(300)],
      { code: null, stdout, stderr: "", timedOut: true },
      120_000,
    )
    const lines = text.split("\n")
    expect(lines[0]).toBe(
      `$ rdctl start ${"x".repeat(200)}… → timed out (120000 ms)`,
    )
    expect(lines.slice(1)).toHaveLength(15)
    expect(lines.at(-1)).toBe("  stdout: line 29")
  })
})

describe("SetupLog", () => {
  it("appends timestamped entries, indents continuation lines and tails", () => {
    const file = join(tempDir(), "logs", "setup.log")
    const log = new SetupLog(file, () => new Date("2026-11-19T20:00:00Z"))
    log.write("one")
    log.write("two\n  detail")
    expect(log.tail(2)).toEqual([
      "2026-11-19T20:00:00.000Z two",
      "      detail",
    ])
  })

  it("rotates at 1 MB", () => {
    const file = join(tempDir(), "setup.log")
    writeFileSync(file, "x".repeat(1024 * 1024 + 1))
    const log = new SetupLog(file)
    log.write("fresh")
    expect(log.tail(5)).toHaveLength(1)
    expect(log.tail(1)[0]).toMatch(/ fresh$/)
  })

  it("never throws", () => {
    // The parent "directory" is a file, so neither mkdir nor append works.
    const parent = join(tempDir(), "file")
    writeFileSync(parent, "")
    const log = new SetupLog(join(parent, "setup.log"))
    expect(() => log.write("x")).not.toThrow()
    expect(log.tail(3)).toEqual([])
  })
})

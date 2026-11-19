// @vitest-environment node
/**
 * Opt-in: runs the requirement CHECKS (never fixes) against this machine and
 * prints the result (or writes it to $SH_REAL_CHECK_OUT).
 * `SH_REAL_CHECK=1 npx vitest run src/main/__tests__/real-check.test.ts`
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir, uptime, userInfo } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { executableSearchPath } from "../devsy/env"
import { loadManifest } from "../installers/manifest"
import { NodeHost } from "../requirements/host"
import { RequirementService } from "../requirements/service"

describe.skipIf(!process.env.SH_REAL_CHECK)("real requirement checks", () => {
  it("checks this machine without changing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-realcheck-"))
    try {
      const service = new RequirementService({
        host: new NodeHost({
          homeDir: homedir(),
          userName: userInfo().username,
          env: {
            ...process.env,
            PATH: executableSearchPath(
              process.env.PATH ?? "",
              process.platform,
              homedir(),
            ),
          },
          openExternal: async () => {
            throw new Error("not in a check")
          },
        }),
        manifest: loadManifest(),
        binDir: join(dir, "bin"),
        settings: () => ({
          defaultIde: "vscode",
          autoUpdateCheck: true,
          firstRunDone: true,
        }),
        pendingFile: join(dir, "pending.json"),
        bootTime: () => Date.now() - uptime() * 1000,
        onChange: () => {},
      })
      const list = await service.check()
      const out = process.env.SH_REAL_CHECK_OUT
      if (out) writeFileSync(out, `${JSON.stringify(list, null, 2)}\n`)
      else console.log(JSON.stringify(list, null, 2))
      expect(list.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

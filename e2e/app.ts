import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ElectronApplication, Page } from "@playwright/test"
import { _electron as electron } from "@playwright/test"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  consoleErrors: string[]
  /** file:// URL of the renderer without query and hash. */
  base: string
}

export interface LaunchOptions {
  /** Pre-seeded settings.json content for the throwaway profile. */
  settings?: Record<string, unknown>
}

/**
 * Launches the built app (run `npm run build` first) from the repository root
 * so package.json "main" and app.getAppPath() behave like a real start.
 *
 * Every launch gets a throwaway Electron profile and a throwaway Devsy home
 * (short /tmp path: Devsy's unix sockets are limited to 104 bytes), removed
 * again when the app closes. Tests never touch ~/.config or ~/.silicon-harbor.
 */
export async function launch(
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), "sh-e2e-profile-"))
  const devsyHome = mkdtempSync("/tmp/sh-e2e-")
  if (options.settings) {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify(options.settings),
    )
  }
  const env = {
    ...process.env,
    SH_USER_DATA_DIR: userData,
    SH_DEVSY_HOME: devsyHome,
  }
  // VS Code's extension host sets this; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [ROOT], env })
  app.on("close", () => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(devsyHome, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  await page.waitForLoadState("domcontentloaded")
  const base = page.url().split(/[?#]/)[0]
  return { app, page, consoleErrors, base }
}

export interface MockParams {
  scenario?: "default" | "first-run" | "empty" | "all-ok"
  platform?: "mac" | "win" | "linux"
  /** Delay multiplier; small values make operations near-instant. */
  speed?: number
  route?: string
}

let runCounter = 0

/** Reloads the renderer against a fresh mock API. */
export async function openMock(
  launched: LaunchedApp,
  params: MockParams = {},
): Promise<Page> {
  // A unique `run` forces a real reload (and a fresh mock): navigating to a
  // URL that differs only in its hash would keep the previous state.
  const query = new URLSearchParams({ mock: "1", run: String(++runCounter) })
  query.set("scenario", params.scenario ?? "default")
  query.set("platform", params.platform ?? "mac")
  query.set("speed", String(params.speed ?? 0.05))
  await launched.page.goto(
    `${launched.base}?${query.toString()}#${params.route ?? "/"}`,
  )
  await launched.page.waitForLoadState("domcontentloaded")
  return launched.page
}

import { dirname, resolve } from "node:path"
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

/**
 * Launches the built app (run `npm run build` first) from the repository root
 * so package.json "main" and app.getAppPath() behave like a real start.
 */
export async function launch(): Promise<LaunchedApp> {
  const env = { ...process.env }
  // VS Code's extension host sets this; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [ROOT], env })
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

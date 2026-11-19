import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ElectronApplication, Page } from "@playwright/test"
import { _electron as electron, expect, test } from "@playwright/test"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

test.beforeAll(async () => {
  // Launch the built app (npm run build first) from the repository root so
  // package.json "main" and app.getAppPath() behave like a real start.
  app = await electron.launch({ args: [ROOT], env: { ...process.env } })
  page = await app.firstWindow()
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })
  await page.waitForLoadState("domcontentloaded")
})

test.afterAll(async () => {
  await app.close()
})

test("renders the Carbon header with both navigation items", async () => {
  const header = page.locator("header")
  await expect(header).toContainText("Silicon Harbor")
  await expect(
    header.locator('a[href="#/"]', { hasText: "Environments" }),
  ).toBeVisible()
  await expect(
    header.locator('a[href="#/settings"]', { hasText: "Settings" }),
  ).toBeVisible()
})

test("lists environments in a data table", async () => {
  await expect(page.locator("h1")).toHaveText("Environments")
  await expect(page.locator("table")).toContainText("core-rtl")
  await expect(page.locator("table")).toContainText("scan-flows")
})

test("validates the repository URL in the New environment modal", async () => {
  await page.getByRole("button", { name: "New environment" }).first().click()
  const input = page.locator("#sh-repo-url")
  await input.fill("git@github.ibm.com:a/b.git")
  await expect(page.getByText("SSH addresses are not supported")).toBeVisible()
  await input.fill("https://github.ibm.com/chipdev/core-rtl")
  const create = page.getByRole("button", { name: "Create and open" })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.locator("h1")).toHaveText("core-rtl")
})

test("reaches the main process over the typed IPC bridge", async () => {
  await page.goto(`${page.url().split("#")[0]}#/settings/updates`)
  await expect(page.locator("main")).toContainText(
    /Silicon Harbor \d+\.\d+\.\d+/,
  )
  await expect(page.locator("main")).toContainText("Electron")
})

test("shows the settings sub-navigation", async () => {
  await page.goto(`${page.url().split("#")[0]}#/settings/ide`)
  await expect(
    page.locator("nav[aria-label='Settings sections']"),
  ).toContainText("This computer")
  await expect(page.locator("h1")).toHaveText("IDE")
})

test("logs no console errors", () => {
  expect(consoleErrors).toEqual([])
})

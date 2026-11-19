/**
 * Smoke tests against the real preload bridge and main process. Until M1/M2
 * implement the environment and requirement handlers, the UI must degrade
 * gracefully (clear messages, no console errors).
 */
import { expect, test } from "@playwright/test"
import { type LaunchedApp, launch } from "./app"

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launch()
})

test.afterAll(async () => {
  await launched.app.close()
})

test("renders the dark Carbon header with both navigation items", async () => {
  const { page } = launched
  const header = page.locator("header")
  await expect(header).toContainText("Silicon Harbor")
  await expect(header).toHaveClass(/bx--header--ui-shell-classic/)
  // Carbon renders header navigation as a menubar of menu items.
  const nav = header.getByRole("navigation", { name: "Main" })
  await expect(
    nav.getByRole("menuitem", { name: "Environments" }),
  ).toBeVisible()
  await expect(nav.getByRole("menuitem", { name: "Settings" })).toBeVisible()
})

test("shows the environments page even when the backend is not ready", async () => {
  const { page } = launched
  await expect(page.locator("h1")).toHaveText("Environments")
  await expect(
    page.getByText(/Could not load your environments|No environments yet/),
  ).toBeVisible()
})

test("never claims the computer is ready without a check result", async () => {
  const { page } = launched
  // Until M2 implements the checks, the real backend rejects them.
  await expect(page.getByTestId("health")).toHaveText(/Not checked|Ready|issue/)
  const text = await page.getByTestId("health").textContent()
  const checked = await page.evaluate(() =>
    window.siliconHarbor
      ?.checkRequirements()
      .then(() => true)
      .catch(() => false),
  )
  if (!checked) expect(text?.trim()).toBe("Not checked")
})

test("reaches the main process over the typed IPC bridge", async () => {
  const { page, base } = launched
  await page.goto(`${base}#/settings/updates`)
  await expect(page.locator("main")).toContainText(
    /Silicon Harbor \d+\.\d+\.\d+/,
  )
  await expect(page.locator("main")).toContainText("Electron")
})

test("shows the settings sub-navigation", async () => {
  const { page, base } = launched
  await page.goto(`${base}#/settings/ide`)
  const nav = page.locator("nav[aria-label='Settings sections']")
  await expect(nav).toContainText("This computer")
  await expect(nav.getByRole("link", { name: "IDE" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await expect(page.locator("h2")).toHaveText("IDE")
})

test("logs no console errors", () => {
  expect(launched.consoleErrors).toEqual([])
})

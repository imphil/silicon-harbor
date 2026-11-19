/**
 * Smoke tests against the real preload bridge and main process (M1 + M2
 * backend, throwaway profile and Devsy home). Requirement checks run for real
 * on the test machine; they only read (fixes are never triggered here).
 */
import { expect, test } from "@playwright/test"
import { type LaunchedApp, launch } from "./app"

let launched: LaunchedApp

test.beforeAll(async () => {
  // Past first run, so the main navigation is visible.
  launched = await launch({ settings: { firstRunDone: true } })
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

test("starts with first-run setup on a fresh profile", async () => {
  const fresh = await launch()
  try {
    await expect(fresh.page.locator("h1")).toHaveText(/Set up your machine/)
    await expect(
      fresh.page.locator("header").getByRole("navigation", { name: "Main" }),
    ).toHaveCount(0)
    expect(fresh.consoleErrors).toEqual([])
  } finally {
    await fresh.app.close()
  }
})

test("shows the environments page from the real backend", async () => {
  const { page } = launched
  await expect(page.locator("h1")).toHaveText("Environments")
  await expect(
    page.getByText(/Could not load your environments|No environments yet/),
  ).toBeVisible()
})

test("shows the real requirement check result in the header", async () => {
  const { page } = launched
  const reqs = await page.evaluate(() =>
    window.siliconHarbor?.checkRequirements(),
  )
  expect(reqs?.length).toBeGreaterThan(0)
  const issues = (reqs ?? []).filter(
    (r) => r.state === "missing" || r.state === "warn",
  ).length
  await expect(page.getByTestId("health")).toHaveText(
    issues === 0 ? "Ready" : issues === 1 ? "1 issue" : `${issues} issues`,
  )
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

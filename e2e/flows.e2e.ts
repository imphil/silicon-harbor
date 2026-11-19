/**
 * User flows against the mock API (`?mock=1`), see src/renderer/src/lib/mock-api.ts.
 */
import { expect, test } from "@playwright/test"
import { type LaunchedApp, launch, openMock } from "./app"

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launch()
  await launched.page.setViewportSize({ width: 960, height: 640 })
})

test.afterAll(async () => {
  await launched.app.close()
})

test("first run: set up the machine, then continue to environments", async () => {
  const page = await openMock(launched, {
    scenario: "first-run",
    platform: "mac",
  })

  await expect(page.locator("h1")).toHaveText("Set up your machine")
  // No main navigation during first-run setup.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)
  await expect(page.getByText("3 items need attention.")).toBeVisible()

  await page.getByRole("button", { name: "Fix all" }).click()
  await expect(page.getByText("Everything is ready.")).toBeVisible()
  await expect(page.getByText(/log out and back in/i).first()).toBeVisible()

  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.locator("h1")).toHaveText("Environments")
  await expect(page.getByTestId("empty-state")).toBeVisible()
  await expect(page.getByTestId("health")).toHaveText("Ready")
})

test("create an environment: five steps, then running in the IDE", async () => {
  const page = await openMock(launched, { scenario: "empty", speed: 0.2 })

  await page.getByRole("button", { name: "New environment" }).first().click()
  const url = page.locator("#sh-repo-url")
  await expect(url).toBeFocused()
  await url.fill("git@github.ibm.com:chipdev/core-rtl.git")
  await expect(page.getByText("SSH addresses are not supported")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Create and open" }),
  ).toBeDisabled()

  await url.fill("https://github.ibm.com/chipdev/core-rtl")
  await expect(page.getByTestId("options-summary")).toContainText("core-rtl")
  await page.getByRole("button", { name: "Create and open" }).click()

  await expect(page).toHaveURL(/#\/environments\/core-rtl$/)
  await expect(page.locator("h1")).toHaveText("Setting up core-rtl")
  await expect(page.getByText("Getting the repository")).toBeVisible()
  await expect(
    page.getByText("Downloading and starting the environment"),
  ).toBeVisible()

  await expect(page.getByTestId("status-tag")).toHaveText("Running", {
    timeout: 15_000,
  })
  await expect(page.getByText("IBM Bob is open.")).toBeVisible()

  await page.getByRole("tab", { name: "Log" }).click()
  await expect(page.getByTestId("log")).toContainText("Environment is ready")

  await page.getByRole("link", { name: "Environments" }).first().click() // breadcrumb
  await expect(page.locator("table")).toContainText("core-rtl")
  await expect(
    page.getByRole("button", { name: "Open in IBM Bob" }),
  ).toBeVisible()
})

test("registry sign-in expired: plain-language error, sign in and retry", async () => {
  const page = await openMock(launched, { scenario: "empty" })

  await page.getByRole("button", { name: "New environment" }).first().click()
  await page
    .locator("#sh-repo-url")
    .fill("https://github.ibm.com/chipdev/denied-tb")
  await page.getByRole("button", { name: "Create and open" }).click()

  const alert = page.getByRole("alert")
  await expect(alert).toContainText(
    "Could not download the environment image",
    {
      timeout: 15_000,
    },
  )
  await expect(alert).toContainText("icr.io has probably expired")
  await expect(page.getByTestId("status-tag")).toHaveText("Problem")
  await expect(page.getByTestId("step-start")).toHaveAttribute(
    "data-state",
    "failed",
  )

  await page.getByRole("button", { name: "Sign in and retry" }).click()
  await expect(page.getByTestId("status-tag")).toHaveText("Running", {
    timeout: 15_000,
  })
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("delete an environment after confirming", async () => {
  const page = await openMock(launched, { scenario: "default" })

  const table = page.locator("table")
  await expect(table).toContainText("scan-flows")
  await page
    .getByRole("button", { name: "More actions for scan-flows" })
    .click()
  await page.getByRole("menuitem", { name: "Delete…" }).click()

  const dialog = page.getByRole("dialog", { name: "Delete scan-flows?" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("Changes you have not pushed")
  await dialog.getByRole("button", { name: "Delete" }).click()

  await expect(table).not.toContainText("scan-flows", { timeout: 10_000 })
  await expect(table).toContainText("core-rtl")
})

test("health status and warning bar lead to the fix in Settings", async () => {
  const page = await openMock(launched, {
    scenario: "default",
    platform: "mac",
  })

  await expect(page.getByTestId("health")).toHaveText("1 issue")
  const bar = page.getByTestId("issue-bar")
  await expect(bar).toContainText("XQuartz is not installed.")
  await bar.getByRole("button", { name: "Fix in Settings" }).click()

  await expect(page).toHaveURL(/#\/settings\/computer$/)
  await page
    .getByTestId("requirement-xquartz")
    .getByRole("button", { name: "Install" })
    .click()
  await expect(page.getByTestId("health")).toHaveText("Ready", {
    timeout: 10_000,
  })
})

test("IDE settings: one row per IDE, default choice and downloads", async () => {
  const page = await openMock(launched, { route: "/settings/computer" })
  await page
    .getByTestId("requirement-ide")
    .getByRole("link", { name: "Manage IDEs" })
    .click()
  await expect(page).toHaveURL(/#\/settings\/ide$/)

  const bob = page.getByTestId("ide-bob")
  await expect(bob).toContainText("IBM Bob")
  await expect(bob).toContainText("Recommended")
  await expect(bob).toContainText("1.0.3")
  await expect(bob.getByLabel("Use by default")).toBeChecked()

  const vscode = page.getByTestId("ide-vscode")
  await expect(vscode).toContainText("Installed")
  await vscode.getByText("Use by default").click()
  await expect(vscode.getByLabel("Use by default")).toBeChecked()
  await expect(bob.getByLabel("Use by default")).not.toBeChecked()

  const codium = page.getByTestId("ide-codium")
  await expect(codium).toContainText("Not installed")
  await expect(codium.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "https://vscodium.com/#install",
  )
  if (process.env.SH_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.SH_SCREENSHOT_DIR}/settings-ide.png`,
    })
})

test("search filters the environment list", async () => {
  const page = await openMock(launched, { scenario: "default" })
  const table = page.locator("table")
  await expect(table).toContainText("cache-tb")
  await page.getByPlaceholder("Search environments").fill("dft")
  await expect(table).toContainText("scan-flows")
  await expect(table).not.toContainText("cache-tb")
})

test("logs no console errors", () => {
  expect(launched.consoleErrors).toEqual([])
})

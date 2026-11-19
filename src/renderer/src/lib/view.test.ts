import { describe, expect, it } from "vitest"
import type { Environment } from "$shared/api"
import {
  currentError,
  matchesSearch,
  primaryAction,
  relativeTime,
  shortRepo,
  statusView,
  stepLabel,
} from "./view"

const base: Environment = {
  id: "core-rtl",
  name: "core-rtl",
  repoUrl: "https://github.ibm.com/chipdev/core-rtl",
  branch: "main",
  ide: "bob",
  state: "running",
}

describe("primaryAction", () => {
  it("opens the IDE of a running environment", () => {
    expect(primaryAction(base)).toEqual({
      kind: "open",
      label: "Open in IBM Bob",
    })
  })

  it("offers start, progress or problem depending on the state", () => {
    expect(primaryAction({ ...base, state: "stopped" }).kind).toBe("start")
    expect(primaryAction({ ...base, state: "unknown" }).kind).toBe("start")
    expect(primaryAction({ ...base, state: "busy" }).label).toBe(
      "View progress",
    )
    expect(primaryAction({ ...base, state: "failed" }).label).toBe(
      "See problem",
    )
  })
})

describe("statusView", () => {
  it("names the running operation while busy", () => {
    const env: Environment = {
      ...base,
      state: "busy",
      operation: {
        id: "op",
        kind: "create",
        state: "running",
        steps: [],
        startedAt: "2026-11-19T10:00:00Z",
      },
    }
    expect(statusView(env)).toEqual({ label: "Setting up…", tag: "blue" })
  })

  it("shows a red Problem tag for failed environments", () => {
    expect(statusView({ ...base, state: "failed" })).toEqual({
      label: "Problem",
      tag: "red",
    })
  })
})

describe("currentError", () => {
  it("returns the error of a failed operation only", () => {
    const error = { code: "registry-auth", title: "t", message: "m" }
    const op = {
      id: "op",
      kind: "start" as const,
      steps: [],
      startedAt: "2026-11-19T10:00:00Z",
      error,
    }
    expect(
      currentError({ ...base, operation: { ...op, state: "failed" } }),
    ).toBe(error)
    expect(
      currentError({ ...base, operation: { ...op, state: "cancelled" } }),
    ).toBeUndefined()
  })
})

describe("stepLabel", () => {
  it("uses the IDE name in the last step", () => {
    expect(stepLabel("ide", "codium")).toBe("Opening VSCodium")
    expect(stepLabel("start")).toBe("Downloading and starting the environment")
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-11-19T12:00:00Z")
  it("formats recent times in words", () => {
    expect(relativeTime("2026-11-19T11:59:30Z", now)).toBe("Just now")
    expect(relativeTime("2026-11-19T11:59:00Z", now)).toBe("1 minute ago")
    expect(relativeTime("2026-11-19T10:00:00Z", now)).toBe("2 hours ago")
    expect(relativeTime("2026-11-18T12:00:00Z", now)).toBe("Yesterday")
    expect(relativeTime("2026-11-16T12:00:00Z", now)).toBe("3 days ago")
  })

  it("handles missing and invalid input", () => {
    expect(relativeTime(undefined, now)).toBe("—")
    expect(relativeTime("not a date", now)).toBe("—")
  })
})

describe("shortRepo and matchesSearch", () => {
  it("drops the scheme and .git", () => {
    expect(shortRepo("https://github.ibm.com/a/b.git")).toBe(
      "github.ibm.com/a/b",
    )
  })

  it("searches name, repository and branch case-insensitively", () => {
    expect(matchesSearch(base, "CORE")).toBe(true)
    expect(matchesSearch(base, "chipdev")).toBe(true)
    expect(matchesSearch(base, "main")).toBe(true)
    expect(matchesSearch(base, "")).toBe(true)
    expect(matchesSearch(base, "dft")).toBe(false)
  })
})

// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { OperationKind, StepState } from "../../shared/api"
import {
  applyStatus,
  createProgress,
  finishProgress,
  type Progress,
  stepForPhase,
} from "../devsy/progress"
import type { StatusEnvelope } from "../devsy/schemas"
import { stdoutJson } from "./fixtures"

function statusEvents(name: string): StatusEnvelope[] {
  return stdoutJson<StatusEnvelope & { kind: string }>(name).filter(
    (e) => e.kind === "status",
  )
}

function states(p: Progress): Record<string, StepState> {
  return Object.fromEntries(p.steps.map((s) => [s.id, s.state]))
}

function replay(name: string, kind: OperationKind): Progress {
  const p = createProgress(kind)
  for (const e of statusEvents(name)) applyStatus(p, e)
  return p
}

describe("progress", () => {
  it("starts a create with check active and the rest pending", () => {
    expect(states(createProgress("create"))).toEqual({
      check: "active",
      clone: "pending",
      start: "pending",
      prepare: "pending",
      ide: "pending",
    })
  })

  it("skips cloning when starting an existing environment", () => {
    expect(createProgress("start").steps[1]).toEqual({
      id: "clone",
      state: "skipped",
    })
  })

  it("walks through all five steps for a recorded create", () => {
    const p = createProgress("create")
    const seen: string[] = []
    for (const e of statusEvents("b-task-logs-follow")) {
      applyStatus(p, e)
      const active = p.steps.find((s) => s.state === "active")
      if (active && seen.at(-1) !== active.id) seen.push(active.id)
    }
    expect(seen).toEqual(["clone", "start", "prepare", "ide"])
    expect(states(p)).toEqual({
      check: "done",
      clone: "done",
      start: "done",
      prepare: "done",
      ide: "done",
    })
  })

  it("hints at a sign-in prompt while a create waits for Devsy", () => {
    const p = createProgress("create")
    expect(p.steps[0]).toEqual({
      id: "check",
      state: "active",
      detail: "Reading the repository. You may be asked to sign in.",
    })
    expect(createProgress("start").steps[0].detail).toBeUndefined()
    for (const e of statusEvents("b-task-logs-follow").slice(0, 1))
      applyStatus(p, e)
    expect(p.steps[0]).toEqual({ id: "check", state: "done" })
  })

  it("shows every step for a clone into a Docker volume", () => {
    const p = createProgress("create")
    const seen: string[] = []
    for (const e of statusEvents("n-volume-clone-logs-follow")) {
      applyStatus(p, e)
      const active = p.steps.find((s) => s.state === "active")
      if (active && seen.at(-1) !== active.id) seen.push(active.id)
    }
    expect(seen).toEqual(["clone", "start", "prepare", "ide"])
    expect(states(p)).toEqual({
      check: "done",
      clone: "done",
      start: "done",
      prepare: "done",
      ide: "done",
    })
  })

  it("names the volume preparation and helper image build", () => {
    const p = createProgress("create")
    const details: string[] = []
    for (const e of statusEvents("n-volume-clone-logs-follow")) {
      applyStatus(p, e)
      const d = p.steps.find((s) => s.id === "clone")?.detail
      if (d && details.at(-1) !== d) details.push(d)
    }
    expect(details.slice(0, 4)).toEqual([
      "Preparing the source volume",
      "Building the helper container (first time only, can take a few minutes)",
      "Preparing the source volume",
      "Cloning the repository",
    ])
  })

  it("shows the clone step when a rebuild clones into a volume again", () => {
    const p = createProgress("rebuild")
    expect(p.steps.find((s) => s.id === "clone")?.state).toBe("skipped")
    const seen: string[] = []
    for (const e of statusEvents("n-volume-clone-logs-follow")) {
      applyStatus(p, e)
      const active = p.steps.find((s) => s.state === "active")
      if (active && seen.at(-1) !== active.id) seen.push(active.id)
    }
    expect(seen).toEqual(["clone", "start", "prepare", "ide"])
    finishProgress(p, "succeeded")
    expect(states(p).clone).toBe("done")
  })

  it("keeps the clone step skipped for a start that does not clone", () => {
    const p = replay("g2-restart-logs-follow", "start")
    finishProgress(p, "succeeded")
    expect(states(p).clone).toBe("skipped")
  })

  it("shows plain-language details for the active phase", () => {
    const p = createProgress("create")
    for (const e of statusEvents("b-task-logs-follow")) {
      applyStatus(p, e)
      if (e.phase === "starting_container" && e.state === "started") break
    }
    expect(p.steps.find((s) => s.id === "start")?.detail).toBe(
      "Downloading the image and starting the container",
    )
  })

  it("ignores duplicate events (with and without pipeline)", () => {
    const p = createProgress("create")
    const events = statusEvents("b-task-logs-follow")
    const changes = events.map((e) => applyStatus(p, e))
    const duplicates = events.filter((e) => !e.pipeline)
    expect(duplicates.length).toBeGreaterThan(0)
    // Replaying the whole stream again changes nothing.
    expect(events.some((e) => applyStatus(p, e))).toBe(false)
    expect(changes.filter(Boolean).length).toBeLessThan(events.length)
  })

  it("restarts without a clone step", () => {
    const p = replay("g2-restart-logs-follow", "start")
    finishProgress(p, "succeeded")
    expect(states(p)).toEqual({
      check: "done",
      clone: "skipped",
      start: "done",
      prepare: "done",
      ide: "done",
    })
  })

  it("marks the download step failed when the image cannot be pulled", () => {
    const p = replay("j2-image-fail-logs", "create")
    finishProgress(p, "failed")
    expect(states(p)).toMatchObject({
      check: "done",
      start: "failed",
      prepare: "pending",
      ide: "pending",
    })
  })

  it("blames the clone step when cloning fails before any event", () => {
    const p = createProgress("create")
    finishProgress(p, "failed", "clone")
    expect(states(p)).toMatchObject({
      check: "done",
      clone: "failed",
      start: "pending",
    })
  })

  it("skips the remaining steps after a cancel", () => {
    const p = replay("k2-cancel-logs-follow", "create")
    finishProgress(p, "cancelled")
    const s = states(p)
    expect(s.check).toBe("done")
    expect(Object.values(s)).not.toContain("active")
    expect(Object.values(s)).toContain("skipped")
  })

  it("uses only the check step for stop, with Devsy's step text", () => {
    const p = createProgress("stop")
    const details: string[] = []
    for (const e of statusEvents("f-stop")) {
      applyStatus(p, e)
      if (p.steps[0].detail) details.push(p.steps[0].detail)
    }
    expect(details).toContain("Stopping workspace resources")
    finishProgress(p, "succeeded")
    expect(states(p)).toEqual({
      check: "done",
      clone: "skipped",
      start: "skipped",
      prepare: "skipped",
      ide: "skipped",
    })
  })

  it("maps every observed up phase except the parent phase", () => {
    const phases = new Set(
      statusEvents("b-task-logs-follow").map((e) => e.phase),
    )
    phases.delete("preparing_devcontainer")
    for (const phase of phases) expect(stepForPhase(phase)).toBeDefined()
  })
})

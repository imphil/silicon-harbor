import type {
  OperationKind,
  OperationStep,
  StepId,
  StepState,
} from "../../shared/api"
import type { StatusEnvelope } from "./schemas"

/**
 * Turns Devsy status events into the five user-facing steps.
 *
 * Rules from the recorded fixtures (docs/developer/devsy/cli-contract.md §2–3):
 * - events arrive twice (with and without `pipeline`) → dedupe;
 * - `operationId` is reused within a stream → key progress by `phase`;
 * - `pipeline` is always "workspace_up" → ignore it, use our operation kind;
 * - the image download happens inside `starting_container`.
 */

export const STEP_ORDER: StepId[] = [
  "check",
  "clone",
  "start",
  "prepare",
  "ide",
]

const PHASE_STEP: Record<string, StepId> = {
  cloning_repository: "clone",
  importing_workspace: "clone",
  resolving_config: "start",
  initialize_command: "start",
  building_image: "start",
  rebuilding_workspace: "start",
  resetting_workspace: "start",
  starting_container: "start",
  injecting_agent: "prepare",
  running_lifecycle_hook: "prepare",
  running_command: "prepare",
  configuring_workspace: "prepare",
  configuring_ssh: "prepare",
  starting_ssh_tunnel: "prepare",
  waiting_for: "prepare",
  launching_ide: "ide",
  ready: "ide",
}

const PHASE_DETAIL: Record<string, string> = {
  cloning_repository: "Cloning the repository",
  importing_workspace: "Importing the workspace",
  resolving_config: "Reading the environment definition",
  initialize_command: "Running the repository's initialize command",
  building_image: "Building the environment image",
  rebuilding_workspace: "Removing the old environment",
  resetting_workspace: "Resetting the environment",
  starting_container: "Downloading the image and starting the container",
  injecting_agent: "Installing the helper inside the environment",
  running_lifecycle_hook: "Running the repository's setup commands",
  running_command: "Running a setup command",
  configuring_workspace: "Configuring the environment",
  configuring_ssh: "Configuring the connection",
  starting_ssh_tunnel: "Connecting to the environment",
  waiting_for: "Waiting for the environment",
  launching_ide: "Starting the IDE",
  ready: "Ready",
}

/**
 * Devsy sub-steps worth naming (its own `step` text otherwise stays out of
 * the UI). All come from our fork's --clone-into-volume bootstrap.
 */
const STEP_DETAIL: Record<string, string> = {
  "preparing the source volume": "Preparing the source volume",
  "downloading the helper image":
    "Downloading the helper container (first time only)",
  "building the helper image":
    "Building the helper container (first time only, can take a few minutes)",
}

export function stepForPhase(phase: string): StepId | undefined {
  return PHASE_STEP[phase]
}

export function phaseDetail(phase: string): string | undefined {
  return PHASE_DETAIL[phase]
}

export interface Progress {
  kind: OperationKind
  steps: OperationStep[]
  /** Dedupe keys of events already applied. */
  seen: Set<string>
  /** Whether any Devsy event arrived yet (ends the "check" step). */
  started: boolean
  /** Named sub-steps (STEP_DETAIL) running now, innermost last. */
  subSteps: string[]
}

const isUpKind = (kind: OperationKind) =>
  kind === "create" || kind === "start" || kind === "rebuild"

export function createProgress(kind: OperationKind): Progress {
  const steps: OperationStep[] = STEP_ORDER.map((id) => {
    let state: StepState = "pending"
    if (id === "check") state = "active"
    else if (!isUpKind(kind)) state = "skipped"
    // Starting an existing workspace never clones.
    else if (id === "clone" && kind !== "create") state = "skipped"
    return { id, state }
  })
  // Before its first event, Devsy reads the repository with the user's Git
  // (a sign-in prompt may appear) and checks the container engine.
  if (kind === "create")
    steps[0].detail = "Reading the repository. You may be asked to sign in."
  if (kind === "stop") steps[0].detail = "Stopping the environment"
  if (kind === "delete") steps[0].detail = "Removing the environment"
  return { kind, steps, seen: new Set(), started: false, subSteps: [] }
}

function step(progress: Progress, id: StepId): OperationStep {
  // STEP_ORDER guarantees presence.
  return progress.steps.find((s) => s.id === id) as OperationStep
}

/** Dedupe key: duplicates share operationId, phase, step and state. */
export function eventKey(
  event: Pick<StatusEnvelope, "operationId" | "phase" | "step" | "state">,
): string {
  return [event.operationId, event.phase, event.step ?? "", event.state].join(
    "|",
  )
}

/** Applies one status event. Returns true when the visible steps changed. */
export function applyStatus(
  progress: Progress,
  event: StatusEnvelope,
): boolean {
  const key = eventKey(event)
  if (progress.seen.has(key)) return false
  progress.seen.add(key)

  const before = JSON.stringify(progress.steps)

  // Stop and delete only show the "check" step, with Devsy's step text.
  if (!isUpKind(progress.kind)) {
    const check = step(progress, "check")
    if (event.state === "failed") check.state = "failed"
    else if (event.step && event.state === "started") check.detail = event.step
    return JSON.stringify(progress.steps) !== before
  }

  if (!progress.started) {
    progress.started = true
    const check = step(progress, "check")
    if (check.state === "active") {
      check.state = "done"
      check.detail = undefined
    }
  }

  const id = stepForPhase(event.phase)
  if (!id) return JSON.stringify(progress.steps) !== before
  const target = step(progress, id)
  const index = STEP_ORDER.indexOf(id)

  if (event.state === "started") {
    // Everything before the current step is finished.
    for (const earlier of progress.steps.slice(0, index)) {
      if (earlier.state === "active" || earlier.state === "pending") {
        earlier.state = "done"
        earlier.detail = undefined
      }
    }
    // A step skipped up front still runs when Devsy reports it: starting or
    // rebuilding a --clone-into-volume workspace goes through the bootstrap
    // container and the clone ("cloning_repository") again.
    if (
      target.state === "pending" ||
      target.state === "active" ||
      target.state === "skipped"
    ) {
      target.state = "active"
      const named = event.step ? STEP_DETAIL[event.step] : undefined
      if (named) progress.subSteps.push(event.step as string)
      target.detail = named ?? phaseDetail(event.phase)
    }
  } else if (event.state === "failed") {
    target.state = "failed"
    target.detail = phaseDetail(event.phase)
  } else if (
    event.state === "succeeded" &&
    event.step &&
    progress.subSteps.at(-1) === event.step
  ) {
    // Back to the enclosing sub-step, or the phase itself.
    progress.subSteps.pop()
    const outer = progress.subSteps.at(-1)
    if (target.state === "active")
      target.detail = outer ? STEP_DETAIL[outer] : phaseDetail(event.phase)
  } else if (event.state === "succeeded" && event.phase === "ready") {
    target.state = "done"
    target.detail = undefined
  }
  return JSON.stringify(progress.steps) !== before
}

export type Outcome = "succeeded" | "failed" | "cancelled"

/**
 * Marks the final state of all steps.
 * @param failedStep the step to blame when no event marked one (e.g. a clone
 *   failure is reported before any status event).
 */
export function finishProgress(
  progress: Progress,
  outcome: Outcome,
  failedStep?: StepId,
): void {
  if (outcome === "succeeded") {
    for (const s of progress.steps) {
      if (s.state !== "skipped") {
        s.state = "done"
        s.detail = undefined
      }
    }
    return
  }

  if (outcome === "cancelled") {
    for (const s of progress.steps) {
      if (s.state === "active" || s.state === "pending") s.state = "skipped"
    }
    return
  }

  if (progress.steps.some((s) => s.state === "failed")) {
    for (const s of progress.steps) if (s.state === "active") s.state = "done"
    return
  }
  const blamed =
    (failedStep && step(progress, failedStep)) ??
    progress.steps.find((s) => s.state === "active") ??
    progress.steps.find((s) => s.state === "pending")
  if (!blamed) return
  const blamedIndex = STEP_ORDER.indexOf(blamed.id)
  for (const s of progress.steps.slice(0, blamedIndex)) {
    if (s.state === "active" || s.state === "pending") {
      s.state = "done"
      s.detail = undefined
    }
  }
  blamed.state = "failed"
}

export function cloneSteps(progress: Progress): OperationStep[] {
  return progress.steps.map((s) => ({ ...s }))
}

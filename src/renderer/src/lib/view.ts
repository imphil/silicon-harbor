/**
 * Pure presentation helpers: labels, tag colours and the primary action per
 * environment state. Kept free of Svelte so they are unit-testable.
 */
import type {
  Environment,
  IdeId,
  OperationKind,
  StepId,
  UserError,
} from "$shared/api"

export const ideLabels: Record<IdeId, string> = {
  vscode: "VS Code",
  bob: "IBM Bob",
  codium: "VSCodium",
}

export const ideOrder: IdeId[] = ["vscode", "bob", "codium"]

export function ideLabel(ide: IdeId | undefined): string {
  return ide ? ideLabels[ide] : "your IDE"
}

/** Labels of the five user-facing steps (PLAN.md §3a). `ide` is IDE-specific. */
export function stepLabel(step: StepId, ide?: IdeId): string {
  switch (step) {
    case "check":
      return "Checking this computer"
    case "clone":
      return "Getting the repository"
    case "start":
      return "Downloading and starting the environment"
    case "prepare":
      return "Preparing the environment"
    case "ide":
      return `Opening ${ideLabel(ide)}`
  }
}

export type TagType = "green" | "gray" | "blue" | "red" | "cool-gray"

export interface StatusView {
  label: string
  tag: TagType
}

const busyLabels: Record<OperationKind, string> = {
  create: "Setting up…",
  start: "Starting…",
  stop: "Stopping…",
  rebuild: "Rebuilding…",
  delete: "Deleting…",
}

export function statusView(env: Environment): StatusView {
  switch (env.state) {
    case "running":
      return { label: "Running", tag: "green" }
    case "stopped":
      return { label: "Stopped", tag: "gray" }
    case "busy":
      return {
        label: env.operation ? busyLabels[env.operation.kind] : "Working…",
        tag: "blue",
      }
    case "failed":
      return { label: "Problem", tag: "red" }
    default:
      return { label: "Unknown", tag: "cool-gray" }
  }
}

export type PrimaryAction =
  | { kind: "open"; label: string }
  | { kind: "start"; label: string }
  | { kind: "progress"; label: string }
  | { kind: "problem"; label: string }

/** The one button shown per row in the environment list. */
export function primaryAction(env: Environment): PrimaryAction {
  switch (env.state) {
    case "running":
      return { kind: "open", label: `Open in ${ideLabel(env.ide)}` }
    case "busy":
      return { kind: "progress", label: "View progress" }
    case "failed":
      return { kind: "problem", label: "See problem" }
    default:
      return { kind: "start", label: "Start" }
  }
}

/** The error worth showing for an environment, if any. */
export function currentError(env: Environment): UserError | undefined {
  const op = env.operation
  if (op?.state !== "failed") return undefined
  return op.error
}

/** Human-friendly relative time ("2 hours ago"); `now` is injectable for tests. */
export function relativeTime(
  iso: string | undefined,
  now = Date.now(),
): string {
  if (!iso) return "—"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "—"
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 60) return "Just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "Yesterday"
  if (days < 30) return `${days} days ago`
  return new Date(then).toLocaleDateString()
}

/** Strips the scheme for compact display: github.ibm.com/org/repo */
export function shortRepo(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "")
}

/** Case-insensitive search over name, repository and branch. */
export function matchesSearch(env: Environment, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [env.name, env.repoUrl, env.branch ?? ""].some((v) =>
    v.toLowerCase().includes(q),
  )
}

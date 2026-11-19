import type {
  RequirementId,
  RequirementStatus,
  Settings,
} from "../../shared/api"
import type { InstallerId, Manifest } from "../installers/manifest"
import type { Host } from "./host"

/** What a fix leaves behind for the user to finish. */
export interface FixOutcome {
  needsRelogin?: boolean
  needsReboot?: boolean
}

export type Pending = "relogin" | "reboot"

export interface RequirementContext {
  host: Host
  settings(): Settings
  /** Our own bin directory (docker-credential-icr), on the Devsy CLI's PATH. */
  binDir: string
  /** Pinned vendor installers. */
  manifest: Manifest
  /** Set when an earlier fix of this requirement still waits for a re-login/reboot. */
  pending: Pending | undefined
  /**
   * Called by a check that sees the re-login/reboot has happened (e.g. DISPLAY
   * is set, the docker group is active). A reboot clears everything anyway.
   */
  resolvePending(): void
  /** Updates the "working" detail shown while a fix runs. */
  progress(detail: string): void
  /** Downloads, verifies and runs a pinned vendor installer (src/main/installers). */
  install(id: InstallerId, options?: { binaryDest?: string }): Promise<void>
  sleep(ms: number): Promise<void>
}

export interface Requirement {
  id: RequirementId
  check(ctx: RequirementContext): Promise<RequirementStatus>
  /** Only called when the last check offered a fix. */
  fix?(ctx: RequirementContext): Promise<FixOutcome | undefined>
}

/** First dotted version number in a text, e.g. "git version 2.47.1" → "2.47.1". */
export function firstVersion(text: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0]
}

export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? ""
}

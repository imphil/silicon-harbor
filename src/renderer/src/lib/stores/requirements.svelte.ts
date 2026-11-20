import type {
  RequirementId,
  RequirementStatus,
  SiliconHarborApi,
} from "$shared/api"
import { attempt } from "./notifications.svelte"

/** "This computer": the requirement checks (implemented by the main process in M2). */
export class RequirementStore {
  list = $state<RequirementStatus[]>([])
  checking = $state(false)
  loaded = $state(false)
  /** ISO 8601: when the list was last checked (not just fixed). */
  checkedAt = $state<string | undefined>(undefined)
  loadError = $state("")
  private unsubscribe?: () => void

  /** Requirements that need attention (missing or wrong, not just being fixed). */
  issues = $derived(
    this.list.filter((r) => r.state === "missing" || r.state === "warn"),
  )
  working = $derived(this.list.some((r) => r.state === "working"))
  allOk = $derived(this.loaded && this.list.every((r) => r.state === "ok"))

  constructor(private readonly api: () => SiliconHarborApi) {}

  async init(): Promise<void> {
    if (this.unsubscribe) return
    this.unsubscribe = this.api().onRequirementsChanged((reqs) => {
      this.list = reqs
      this.loaded = true
      // Every complete result (a check, also the hourly one in the
      // background) arrives here; one with a fix still running is partial.
      if (!reqs.some((r) => r.state === "working"))
        this.checkedAt = new Date().toISOString()
    })
    await this.check()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async check(): Promise<void> {
    this.checking = true
    try {
      this.list = await this.api().checkRequirements()
      this.checkedAt = new Date().toISOString()
      this.loadError = ""
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.checking = false
      this.loaded = true
    }
  }

  /** Checks again when the last check is older than maxAgeMs. */
  async checkIfOlderThan(maxAgeMs: number): Promise<void> {
    const at = this.checkedAt ? Date.parse(this.checkedAt) : 0
    if (!this.checking && Date.now() - at > maxAgeMs) await this.check()
  }

  fix(id: RequirementId) {
    return attempt("Could not fix this", () => this.api().fixRequirement(id))
  }

  async fixAll(): Promise<void> {
    await Promise.all(
      this.list
        .filter((r) => r.fix && r.state !== "ok")
        .map((r) => this.fix(r.id)),
    )
  }
}

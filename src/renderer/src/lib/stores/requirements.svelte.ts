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
      this.loadError = ""
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.checking = false
      this.loaded = true
    }
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

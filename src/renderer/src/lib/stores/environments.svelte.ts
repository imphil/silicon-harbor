import type {
  CreateEnvironmentRequest,
  Environment,
  IdeId,
  SiliconHarborApi,
} from "$shared/api"
import { attempt } from "./notifications.svelte"

/**
 * Environments as the main process reports them. Loaded once, then kept up to
 * date by onEnvironmentsChanged; actions go straight to the API and the list
 * updates through the event.
 */
export class EnvironmentStore {
  list = $state<Environment[]>([])
  loaded = $state(false)
  loadError = $state("")
  private unsubscribe?: () => void

  constructor(private readonly api: () => SiliconHarborApi) {}

  async init(): Promise<void> {
    if (this.unsubscribe) return
    this.unsubscribe = this.api().onEnvironmentsChanged((envs) => {
      this.list = envs
      this.loaded = true
    })
    try {
      this.list = await this.api().listEnvironments()
      this.loadError = ""
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.loaded = true
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  byId(id: string): Environment | undefined {
    return this.list.find((e) => e.id === id)
  }

  create(req: CreateEnvironmentRequest) {
    return attempt("Could not create the environment", () =>
      this.api().createEnvironment(req),
    )
  }

  start(id: string) {
    return attempt("Could not start the environment", () =>
      this.api().startEnvironment(id),
    )
  }

  stop(id: string) {
    return attempt("Could not stop the environment", () =>
      this.api().stopEnvironment(id),
    )
  }

  rebuild(id: string) {
    return attempt("Could not rebuild the environment", () =>
      this.api().rebuildEnvironment(id),
    )
  }

  remove(id: string) {
    return attempt("Could not delete the environment", () =>
      this.api().deleteEnvironment(id),
    )
  }

  cancel(id: string) {
    return attempt("Could not cancel", () => this.api().cancelOperation(id))
  }

  openInIde(id: string, ide?: IdeId) {
    return attempt("Could not open the IDE", () =>
      this.api().openInIde(id, ide),
    )
  }

  openTerminal(id: string) {
    return attempt("Could not open a terminal", () =>
      this.api().openTerminal(id),
    )
  }
}

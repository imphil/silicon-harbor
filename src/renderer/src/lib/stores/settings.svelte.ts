import type { Settings, SiliconHarborApi } from "$shared/api"
import { attempt } from "./notifications.svelte"

const DEFAULTS: Settings = {
  defaultIde: "bob",
  autoUpdateCheck: true,
  firstRunDone: true,
}

export class SettingsStore {
  value = $state<Settings>({ ...DEFAULTS })
  loaded = $state(false)

  constructor(private readonly api: () => SiliconHarborApi) {}

  async init(): Promise<void> {
    // The IDE check may change the default IDE (the only one installed);
    // re-read the settings after every check.
    this.api().onRequirementsChanged(() => void this.refresh())
    try {
      this.value = await this.api().getSettings()
    } catch {
      // Without settings from the main process, behave like an existing
      // installation instead of trapping the user in first-run setup.
      this.value = { ...DEFAULTS }
    } finally {
      this.loaded = true
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.value = await this.api().getSettings()
    } catch {
      // keep what we have
    }
  }

  async update(patch: Partial<Settings>): Promise<void> {
    const previous = this.value
    this.value = { ...this.value, ...patch }
    const saved = await attempt("Could not save the setting", () =>
      this.api().updateSettings(patch),
    )
    this.value = saved ?? previous
  }
}

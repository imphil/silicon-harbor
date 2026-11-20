import { api } from "../api"
import { CredentialStore } from "./credentials.svelte"
import { EnvironmentStore } from "./environments.svelte"
import { RequirementStore } from "./requirements.svelte"
import { SettingsStore } from "./settings.svelte"

export { attempt, notifications } from "./notifications.svelte"

/** App-wide singletons. Initialised once from App.svelte. */
export const environments = new EnvironmentStore(api)
export const requirements = new RequirementStore(api)
export const settings = new SettingsStore(api)
/** Loaded when Settings › Credentials is first opened (it asks the servers). */
export const credentials = new CredentialStore(api)

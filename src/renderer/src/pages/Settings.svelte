<script lang="ts">
import type { AppInfo } from "$shared/api"
import {
  Button,
  Checkbox,
  StructuredList,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
} from "carbon-components-svelte"
import CredentialsPane from "../lib/components/CredentialsPane.svelte"
import IdeList from "../lib/components/IdeList.svelte"
import RequirementsList from "../lib/components/RequirementsList.svelte"
import SettingsNav from "../lib/components/SettingsNav.svelte"
import { api, usingMock } from "../lib/api"
import { isSettingsSection, settingsSections } from "../lib/settings-sections"
import { attempt, notifications, settings } from "../lib/stores"

let { params = {} }: { params?: { section?: string } } = $props()

const section = $derived(
  params.section && isSettingsSection(params.section)
    ? params.section
    : "computer",
)
const title = $derived(
  settingsSections.find((s) => s.id === section)?.label ?? "",
)

let info = $state<AppInfo | null>(null)

$effect(() => {
  api()
    .getAppInfo()
    .then((value) => (info = value))
    .catch(() => (info = null))
})

const platformName = $derived.by(() => {
  switch (info?.platform) {
    case "darwin":
      return "macOS"
    case "win32":
      return "Windows"
    case "linux":
      return "Fedora"
    default:
      return info?.platform ?? ""
  }
})

async function copyDiagnostics(): Promise<void> {
  const ok = await attempt("Could not create the diagnostics", async () => {
    await api().copyDiagnostics()
    return true
  })
  if (ok) {
    notifications.push({
      kind: "success",
      title: "Diagnostics copied",
      subtitle: "Paste them into your support request.",
    })
  }
}
</script>

<div class="sh-page">
  <div class="sh-page-header">
    <h1>Settings</h1>
  </div>

  <div class="sh-settings">
    <div class="sh-settings-nav">
      <SettingsNav {section} />
    </div>

    <section class="sh-settings-body" aria-labelledby="sh-section-title">
      <h2 id="sh-section-title">{title}</h2>

      {#if section === "computer"}
        <p class="sh-muted">
          The tools Silicon Harbor needs{platformName ? ` on ${platformName}` : ""}.
          Checked every time the app starts.
        </p>
        <RequirementsList showFixAll manageIdeLink />
      {:else if section === "credentials"}
        <p class="sh-muted">
          The sign-ins your environments use. They are kept in your system's
          password store and given to environments when they start.
        </p>
        <CredentialsPane />
      {:else if section === "ide"}
        <p class="sh-muted">
          New environments open in the IDE you use by default. IBM Bob is
          recommended.
        </p>
        <IdeList />
      {:else if section === "updates"}
        <StructuredList condensed>
          <StructuredListBody>
            <StructuredListRow>
              <StructuredListCell noWrap>Silicon Harbor</StructuredListCell>
              <StructuredListCell>
                {info ? `Silicon Harbor ${info.appVersion}` : "…"}
              </StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Electron</StructuredListCell>
              <StructuredListCell>{info?.electronVersion ?? "…"}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Devsy engine</StructuredListCell>
              <StructuredListCell>
                {info?.devsyPath ? "Bundled, pinned to this release" : "Not found"}
              </StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell noWrap>Platform</StructuredListCell>
              <StructuredListCell>
                {info ? `${platformName} · ${info.arch}` : "…"}
              </StructuredListCell>
            </StructuredListRow>
          </StructuredListBody>
        </StructuredList>
        <Checkbox
          labelText="Check for updates automatically"
          checked={settings.value.autoUpdateCheck}
          on:change={(e) =>
            settings.update({
              autoUpdateCheck: (e.currentTarget as HTMLInputElement).checked,
            })}
        />
        <div>
          <Button kind="tertiary" disabled>Check for updates (coming soon)</Button>
        </div>
      {:else if section === "support"}
        <p class="sh-muted">
          A diagnostics text contains the app and engine logs and the results of the
          computer check. It contains no source code or passwords.
        </p>
        <div>
          <Button kind="tertiary" on:click={copyDiagnostics}>Copy diagnostics</Button>
        </div>
      {/if}

      {#if usingMock()}
        <p class="sh-muted sh-small">Demo data: running against the mock API.</p>
      {/if}
    </section>
  </div>
</div>

<style>
  .sh-settings {
    display: flex;
    flex-wrap: wrap;
    gap: 2rem;
    align-items: flex-start;
  }
  .sh-settings-nav {
    flex: 1 1 12rem;
    max-width: 15rem;
  }
  .sh-settings-body {
    flex: 999 1 30rem;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sh-settings-body h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 400;
  }
  .sh-settings-body p {
    margin: 0;
  }
  .sh-small {
    font-size: 0.75rem;
  }
</style>

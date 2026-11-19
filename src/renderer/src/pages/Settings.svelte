<script lang="ts">
import type { AppInfo } from "$shared/api"
import {
  Button,
  InlineNotification,
  RadioTile,
  StructuredList,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  TileGroup,
} from "carbon-components-svelte"
import { api } from "../lib/api"
import { isSettingsSection, settingsSections } from "../lib/settings-sections"

let { params = {} }: { params?: { section?: string } } = $props()

const section = $derived(
  params.section && isSettingsSection(params.section)
    ? params.section
    : "computer",
)
const title = $derived(
  settingsSections.find((s) => s.id === section)?.label ?? "",
)

let ide = $state("vscode")
let info = $state<AppInfo | null>(null)
let infoError = $state("")

$effect(() => {
  api()
    .getAppInfo()
    .then((value) => (info = value))
    .catch((error: unknown) => (infoError = String(error)))
})

// Spike data until the requirement checks (M2) exist.
const requirements = [
  {
    name: "Rancher Desktop",
    detail: "Running with dockerd (moby).",
    version: "1.20.0",
    ok: true,
  },
  {
    name: "XQuartz",
    detail: "Not installed. Graphical tools will not open.",
    version: "—",
    ok: false,
  },
  {
    name: "docker-credential-icr",
    detail: "Set for icr.io.",
    version: "0.4.0",
    ok: true,
  },
  {
    name: "Git Credential Manager",
    detail: "Signed in to github.ibm.com.",
    version: "2.6.1",
    ok: true,
  },
]
</script>

<div class="sh-page">
  <div class="sh-page-header">
    <h1>{title}</h1>
  </div>

  {#if section === "computer"}
    <div class="sh-stack">
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="XQuartz is not installed."
        subtitle="Graphical tools in your environments will not open."
      />
      <StructuredList condensed>
        <StructuredListBody>
          {#each requirements as r (r.name)}
            <StructuredListRow>
              <StructuredListCell noWrap><strong>{r.name}</strong></StructuredListCell>
              <StructuredListCell>{r.detail}</StructuredListCell>
              <StructuredListCell><span class="sh-mono">{r.version}</span></StructuredListCell>
              <StructuredListCell>
                {#if !r.ok}<Button kind="tertiary" size="small">Install</Button>{/if}
              </StructuredListCell>
            </StructuredListRow>
          {/each}
        </StructuredListBody>
      </StructuredList>
      <div><Button kind="secondary">Check again</Button></div>
    </div>
  {:else if section === "ide"}
    <TileGroup legendText="New environments open with this IDE" name="ide" bind:selected={ide}>
      <RadioTile value="vscode">VS Code</RadioTile>
      <RadioTile value="bob">IBM Bob</RadioTile>
      <RadioTile value="codium">VSCodium</RadioTile>
    </TileGroup>
    <p class="sh-muted" style="margin-top: 1rem">Selected: {ide}</p>
  {:else if section === "updates"}
    <div class="sh-stack">
      {#if info}
        <p>Silicon Harbor {info.appVersion} · Electron {info.electronVersion} · {info.platform}/{info.arch}</p>
        <p>
          Devsy engine:
          {#if info.devsyPath}<span class="sh-mono">{info.devsyPath}</span>{:else}not bundled{/if}
        </p>
      {:else if infoError}
        <p class="sh-muted">{infoError}</p>
      {/if}
      <div><Button kind="tertiary">Check for updates</Button></div>
    </div>
  {:else}
    <div class="sh-stack">
      <p class="sh-muted">A diagnostics bundle contains logs and the results of the computer check. It contains no source code or passwords.</p>
      <div><Button kind="tertiary">Create diagnostics bundle</Button></div>
    </div>
  {/if}
</div>

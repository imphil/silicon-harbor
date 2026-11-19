<script lang="ts">
import type { IdeId } from "$shared/api"
import {
  Button,
  InlineNotification,
  RadioButton,
  Tag,
} from "carbon-components-svelte"
import { requirements, settings } from "../stores"
import RequirementIcon from "./RequirementIcon.svelte"

/** Settings › IDE: every supported IDE, the default choice and downloads. */

const ides = $derived(requirements.list.find((r) => r.id === "ide")?.ides ?? [])
const defaultIde = $derived(settings.value.defaultIde)
const defaultMissing = $derived(
  ides.length > 0 && !ides.some((i) => i.id === defaultIde && i.installed),
)
const anyInstalled = $derived(ides.some((i) => i.installed))
const defaultLabel = $derived(
  ides.find((i) => i.id === defaultIde)?.label ?? defaultIde,
)

function choose(id: IdeId): void {
  if (id !== defaultIde) void settings.update({ defaultIde: id })
}
</script>

<div class="sh-ides">
  {#if !requirements.loaded}
    <p class="sh-muted">Looking for IDEs…</p>
  {:else if ides.length === 0}
    <p class="sh-muted">The IDE check did not run. Check again.</p>
  {:else}
    {#if !anyInstalled}
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="No IDE installed."
        subtitle="Install IBM Bob (recommended), then check again."
      />
    {:else if defaultMissing}
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title={`${defaultLabel} is not installed.`}
        subtitle="Choose one of the installed IDEs, or install it and check again."
      />
    {/if}

    <ul class="sh-ide-list" aria-label="IDEs">
      {#each ides as ide (ide.id)}
        <li class="sh-ide-row" data-testid={`ide-${ide.id}`}>
          <span class="sh-ide-icon">
            {#if ide.installed}<RequirementIcon state="ok" />{/if}
          </span>
          <span class="sh-ide-text">
            <strong>
              {ide.label}
              {#if ide.recommended}<Tag size="sm" type="blue">Recommended</Tag>{/if}
            </strong>
            <span class="sh-muted">{ide.installed ? "Installed" : "Not installed"}</span>
          </span>
          <span class="sh-ide-version sh-mono">{ide.version ?? ""}</span>
          <span class="sh-ide-action">
            {#if ide.installed}
              <RadioButton
                name="sh-default-ide"
                value={ide.id}
                labelText="Use by default"
                checked={ide.id === defaultIde}
                on:change={() => choose(ide.id)}
              />
            {:else}
              <Button
                kind="tertiary"
                size="small"
                href={ide.downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </Button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="sh-muted sh-small">
    Downloads open the vendor's page in your browser. After installing, check again.
    You can still pick another IDE for each environment.
  </p>

  <div class="sh-ide-buttons">
    <Button
      kind="secondary"
      disabled={requirements.checking}
      on:click={() => requirements.check()}
    >
      {requirements.checking ? "Checking…" : "Check again"}
    </Button>
  </div>
</div>

<style>
  .sh-ides {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sh-ide-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sh-ide-row {
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr) 5.5rem 10rem;
    gap: 1rem;
    align-items: center;
    padding: 1rem;
    min-height: 4.5rem;
    box-sizing: border-box;
    background: var(--cds-layer-01, #f4f4f4);
    border-bottom: 1px solid var(--cds-border-subtle-01, #e0e0e0);
  }
  .sh-ide-icon {
    display: flex;
    justify-content: center;
  }
  .sh-ide-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: 0.875rem;
    line-height: 1.25rem;
    min-width: 0;
  }
  .sh-ide-text strong {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
  }
  .sh-ide-version {
    font-size: 0.8125rem;
    color: var(--cds-text-secondary, #525252);
  }
  .sh-ide-action {
    display: flex;
    justify-content: flex-end;
  }
  .sh-ide-buttons {
    display: flex;
    justify-content: flex-end;
  }
  .sh-small {
    font-size: 0.75rem;
  }
  @media (max-width: 42rem) {
    .sh-ide-row {
      grid-template-columns: 2rem minmax(0, 1fr);
    }
    .sh-ide-version {
      display: none;
    }
    .sh-ide-action {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>

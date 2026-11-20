<script lang="ts">
import { Button, InlineNotification } from "carbon-components-svelte"
import { requirements } from "../stores"
import RequirementIcon from "./RequirementIcon.svelte"

let {
  showFixAll = false,
  manageIdeLink = false,
}: {
  showFixAll?: boolean
  /** Link the IDE and GitHub rows to their Settings pages (not during first-run setup). */
  manageIdeLink?: boolean
} = $props()

const needsRelogin = $derived(
  requirements.list.some((r) => r.state === "ok" && /log out/i.test(r.detail)),
)
</script>

<div class="sh-req">
  {#if requirements.loadError}
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title="Could not check this computer."
      subtitle={requirements.loadError}
    />
  {:else if !requirements.loaded}
    <p class="sh-muted">Checking this computer…</p>
  {:else if requirements.issues.length > 0}
    <InlineNotification
      kind="warning"
      lowContrast
      hideCloseButton
      title={requirements.issues.length === 1
        ? "1 item needs attention."
        : `${requirements.issues.length} items need attention.`}
      subtitle={`${
        requirements.issues.length > 1 && showFixAll
          ? "You can fix them one by one or all at once. "
          : ""
      }You will see the usual system prompt for administrator rights.`}
    />
  {:else if !requirements.working}
    <InlineNotification
      kind="success"
      lowContrast
      hideCloseButton
      title="Everything is ready."
      subtitle={needsRelogin
        ? "Some changes take effect after you log out and back in."
        : ""}
    />
  {/if}

  {#if requirements.list.length > 0}
    <ul class="sh-req-list" aria-label="Requirements">
      {#each requirements.list as req (req.id)}
        <li class="sh-req-row" data-testid={`requirement-${req.id}`}>
          <span class="sh-req-icon"><RequirementIcon state={req.state} /></span>
          <span class="sh-req-text">
            <strong>{req.title}</strong>
            <span class="sh-muted">{req.detail}</span>
          </span>
          <span class="sh-req-version sh-mono">{req.version ?? ""}</span>
          <span class="sh-req-action">
            {#if req.state === "working"}
              <span class="sh-muted">Working…</span>
            {:else if req.fix && req.state !== "ok"}
              <Button
                kind="tertiary"
                size="small"
                on:click={() => requirements.fix(req.id)}
              >
                {req.fix.label}
              </Button>
            {:else if req.id === "ide" && manageIdeLink}
              <Button kind="ghost" size="small" href="#/settings/ide">
                Manage IDEs
              </Button>
            {:else if req.id === "git-credentials" && manageIdeLink && req.state === "ok"}
              <Button kind="ghost" size="small" href="#/settings/credentials">
                Manage credentials
              </Button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="sh-muted sh-small">
    Installers are downloaded from the vendor and checked before they run.
  </p>

  <div class="sh-req-buttons">
    <Button
      kind="secondary"
      disabled={requirements.checking}
      on:click={() => requirements.check()}
    >
      {requirements.checking ? "Checking…" : "Check again"}
    </Button>
    {#if showFixAll && requirements.issues.some((r) => r.fix)}
      <Button on:click={() => requirements.fixAll()}>Fix all</Button>
    {/if}
  </div>
</div>

<style>
  .sh-req {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sh-req-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sh-req-row {
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
  .sh-req-icon {
    display: flex;
    justify-content: center;
  }
  .sh-req-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    font-size: 0.875rem;
    line-height: 1.25rem;
    min-width: 0;
  }
  .sh-req-text strong {
    font-weight: 600;
  }
  .sh-req-version {
    font-size: 0.8125rem;
    color: var(--cds-text-secondary, #525252);
  }
  .sh-req-action {
    display: flex;
    justify-content: flex-end;
  }
  .sh-req-buttons {
    display: flex;
    gap: 1px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .sh-small {
    font-size: 0.75rem;
  }
  @media (max-width: 42rem) {
    .sh-req-row {
      grid-template-columns: 2rem minmax(0, 1fr);
    }
    .sh-req-version {
      display: none;
    }
    .sh-req-action {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>

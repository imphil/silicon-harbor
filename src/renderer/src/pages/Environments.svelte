<script lang="ts">
import type { Environment } from "$shared/api"
import {
  Button,
  DataTable,
  DataTableSkeleton,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Toolbar,
  ToolbarContent,
  ToolbarSearch,
} from "carbon-components-svelte"
import type { DataTableHeader } from "carbon-components-svelte/src/DataTable/DataTable.svelte"
import Add from "carbon-icons-svelte/lib/Add.svelte"
import { push } from "svelte-spa-router"
import DeleteEnvironmentModal from "../lib/components/DeleteEnvironmentModal.svelte"
import IssueBar from "../lib/components/IssueBar.svelte"
import NewEnvironmentModal from "../lib/components/NewEnvironmentModal.svelte"
import StatusTag from "../lib/components/StatusTag.svelte"
import { attempt, environments } from "../lib/stores"
import { api } from "../lib/api"
import {
  ideLabel,
  matchesSearch,
  primaryAction,
  relativeTime,
  shortRepo,
} from "../lib/view"

let newOpen = $state(false)
let deleting = $state<Environment | null>(null)
let query = $state("")

// Re-render relative times once a minute.
let now = $state(Date.now())
$effect(() => {
  const timer = setInterval(() => (now = Date.now()), 60_000)
  return () => clearInterval(timer)
})

const headers: DataTableHeader<Environment>[] = [
  { key: "name", value: "Name" },
  { key: "branch", value: "Branch" },
  { key: "ide", value: "IDE" },
  { key: "state", value: "Status" },
  { key: "lastUsedAt", value: "Last used" },
  { key: "actions", value: "Actions", empty: true },
]

const rows = $derived(
  environments.list
    .filter((e) => matchesSearch(e, query))
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "")),
)

const detailHref = (env: Environment) =>
  `#/environments/${encodeURIComponent(env.id)}`

function runPrimary(env: Environment): void {
  const action = primaryAction(env)
  if (action.kind === "open") void environments.openInIde(env.id)
  else if (action.kind === "start") {
    void environments.start(env.id)
    void push(`/environments/${encodeURIComponent(env.id)}`)
  } else void push(`/environments/${encodeURIComponent(env.id)}`)
}

function asEnv(row: unknown): Environment {
  return row as Environment
}
</script>

<div class="sh-page">
  <div class="sh-page-header">
    <div>
      <h1>Environments</h1>
      <p class="sh-muted">Each environment is one repository, ready to code in.</p>
    </div>
    <Button icon={Add} on:click={() => (newOpen = true)}>New environment</Button>
  </div>

  <IssueBar />

  {#if environments.loadError}
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title="Could not load your environments."
      subtitle={environments.loadError}
    />
  {:else if !environments.loaded}
    <DataTableSkeleton
      showHeader={false}
      headers={["Name", "Branch", "IDE", "Status", "Last used", ""]}
      rows={3}
    />
  {:else if environments.list.length === 0}
    <div class="sh-empty" data-testid="empty-state">
      <h2>No environments yet</h2>
      <p class="sh-muted">
        Paste the address of a Git repository on github.ibm.com. Silicon Harbor sets
        up everything it needs and opens it in your IDE.
      </p>
      <Button on:click={() => (newOpen = true)}>New environment</Button>
    </div>
  {:else}
    <DataTable {headers} {rows} size="tall">
      <Toolbar size="sm">
        <ToolbarContent>
          <ToolbarSearch
            persistent
            bind:value={query}
            placeholder="Search environments"
          />
        </ToolbarContent>
      </Toolbar>
      <svelte:fragment slot="cell" let:row let:cell>
        {@const env = asEnv(row)}
        {#if cell.key === "name"}
          <div class="sh-name">
            <a href={detailHref(env)}><strong>{env.name}</strong></a>
            <span class="sh-muted sh-small">{shortRepo(env.repoUrl)}</span>
          </div>
        {:else if cell.key === "branch"}
          <span class="sh-mono sh-small">{env.branch ?? "Default branch"}</span>
        {:else if cell.key === "ide"}
          {ideLabel(env.ide)}
        {:else if cell.key === "state"}
          <StatusTag {env} />
        {:else if cell.key === "lastUsedAt"}
          <span class="sh-muted">{relativeTime(env.lastUsedAt, now)}</span>
        {:else if cell.key === "actions"}
          <div class="sh-actions">
            <Button kind="tertiary" size="small" on:click={() => runPrimary(env)}>
              {primaryAction(env).label}
            </Button>
            <OverflowMenu flipped iconDescription={`More actions for ${env.name}`}>
              <OverflowMenuItem
                text="Open terminal"
                disabled={env.state !== "running"}
                on:click={() => environments.openTerminal(env.id)}
              />
              <OverflowMenuItem text="Show log" href={detailHref(env)} />
              <OverflowMenuItem
                text="Stop"
                disabled={env.state !== "running"}
                on:click={() => environments.stop(env.id)}
              />
              <OverflowMenuItem
                text="Rebuild"
                disabled={env.state === "busy"}
                on:click={() => environments.rebuild(env.id)}
              />
              <OverflowMenuItem
                text="Copy diagnostics"
                on:click={() =>
                  attempt("Could not copy diagnostics", () =>
                    api().copyDiagnostics(env.id),
                  )}
              />
              <OverflowMenuItem
                danger
                hasDivider
                text="Delete…"
                on:click={() => (deleting = env)}
              />
            </OverflowMenu>
          </div>
        {/if}
      </svelte:fragment>
    </DataTable>
    {#if rows.length === 0}
      <p class="sh-muted sh-no-match">No environment matches “{query}”.</p>
    {/if}
  {/if}
</div>

<NewEnvironmentModal bind:open={newOpen} />
<DeleteEnvironmentModal bind:env={deleting} />

<style>
  .sh-name {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .sh-small {
    font-size: 0.75rem;
  }
  .sh-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }
  .sh-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
    padding: 4rem 2rem;
    background: var(--cds-layer-01, #f4f4f4);
  }
  .sh-empty h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 400;
  }
  .sh-empty p {
    max-width: 30rem;
    margin: 0;
  }
  .sh-no-match {
    padding: 1rem;
  }
</style>

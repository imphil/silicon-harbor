<script lang="ts">
import {
  Button,
  DataTable,
  EmptyState,
  OverflowMenu,
  OverflowMenuItem,
  Tag,
  Toggle,
} from "carbon-components-svelte"
import type { DataTableHeader } from "carbon-components-svelte/src/DataTable/DataTable.svelte"
import Add from "carbon-icons-svelte/lib/Add.svelte"
import NewEnvironmentModal from "../lib/components/NewEnvironmentModal.svelte"

type Status = "running" | "stopped" | "starting" | "error"
type Row = {
  id: string
  name: string
  repo: string
  branch: string
  ide: string
  status: Status
}

const statusTag: Record<
  Status,
  { label: string; type: "green" | "gray" | "blue" | "red" }
> = {
  running: { label: "Running", type: "green" },
  stopped: { label: "Stopped", type: "gray" },
  starting: { label: "Starting…", type: "blue" },
  error: { label: "Problem", type: "red" },
}

const headers: DataTableHeader<Row>[] = [
  { key: "name", value: "Name" },
  { key: "branch", value: "Branch" },
  { key: "ide", value: "IDE" },
  { key: "status", value: "Status" },
  { key: "actions", empty: true, value: "Actions" },
]

// Spike data until the Devsy integration (M1) provides real environments.
const rows: Row[] = [
  {
    id: "core-rtl",
    name: "core-rtl",
    repo: "github.ibm.com/chipdev/core-rtl",
    branch: "main",
    ide: "VS Code",
    status: "running" as Status,
  },
  {
    id: "scan-flows",
    name: "scan-flows",
    repo: "github.ibm.com/dft/scan-flows",
    branch: "feat/scan-compression",
    ide: "IBM Bob",
    status: "stopped" as Status,
  },
]

let showEmpty = $state(false)
let newOpen = $state(false)
let lastAction = $state("")
</script>

<div class="sh-page">
  <div class="sh-page-header">
    <div>
      <h1>Environments</h1>
      <p class="sh-muted">Each environment is one repository, ready to code in.</p>
    </div>
    <Button icon={Add} on:click={() => (newOpen = true)}>New environment</Button>
  </div>

  <div style="margin-bottom: 1rem">
    <Toggle size="sm" labelText="Spike: show empty state" bind:toggled={showEmpty} />
  </div>

  {#if showEmpty}
    <EmptyState
      titleText="No environments yet"
      subtitleText="Paste the URL of a Git repository on github.ibm.com. Silicon Harbor sets up everything it needs and opens it in your IDE."
    >
      <Button on:click={() => (newOpen = true)}>New environment</Button>
    </EmptyState>
  {:else}
    <DataTable {headers} {rows}>
      <svelte:fragment slot="cell" let:row let:cell>
        {#if cell.key === "name"}
          <a href={`#/environments/${row.id}`}><strong>{row.name}</strong></a>
          <div class="sh-muted" style="font-size: 0.75rem">{row.repo}</div>
        {:else if cell.key === "branch"}
          <span class="sh-mono">{cell.value}</span>
        {:else if cell.key === "status"}
          <Tag type={statusTag[row.status as Status].type}>
            {statusTag[row.status as Status].label}
          </Tag>
        {:else if cell.key === "actions"}
          <div class="sh-actions">
            {#if row.status === "running"}
              <Button
                kind="tertiary"
                size="small"
                on:click={() => (lastAction = `open ${row.id}`)}
              >
                Open in {row.ide}
              </Button>
            {:else}
              <Button
                kind="tertiary"
                size="small"
                on:click={() => (lastAction = `start ${row.id}`)}
              >
                Start
              </Button>
            {/if}
            <OverflowMenu flipped iconDescription={`More actions for ${row.name}`}>
              <OverflowMenuItem text="Open terminal" />
              <OverflowMenuItem text="Show log" href={`#/environments/${row.id}`} />
              <OverflowMenuItem text="Stop" />
              <OverflowMenuItem text="Rebuild" />
              <OverflowMenuItem
                danger
                hasDivider
                text="Delete…"
                on:click={() => (lastAction = `delete ${row.id}`)}
              />
            </OverflowMenu>
          </div>
        {:else}
          {cell.value}
        {/if}
      </svelte:fragment>
    </DataTable>
    {#if lastAction}
      <p class="sh-muted" style="margin-top: 0.5rem">Last action: {lastAction}</p>
    {/if}
  {/if}
</div>

<NewEnvironmentModal bind:open={newOpen} />

<style>
  .sh-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.25rem;
  }
</style>

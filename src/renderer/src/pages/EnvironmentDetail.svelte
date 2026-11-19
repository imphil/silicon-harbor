<script lang="ts">
import type { Environment, UserError } from "$shared/api"
import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  InlineNotification,
  NotificationActionButton,
  StructuredList,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  Tab,
  TabContent,
  Tabs,
} from "carbon-components-svelte"
import DeleteEnvironmentModal from "../lib/components/DeleteEnvironmentModal.svelte"
import LogView from "../lib/components/LogView.svelte"
import OperationSteps from "../lib/components/OperationSteps.svelte"
import StatusTag from "../lib/components/StatusTag.svelte"
import { api } from "../lib/api"
import { attempt, environments } from "../lib/stores"
import { currentError, ideLabel, relativeTime } from "../lib/view"

let { params = {} }: { params?: { id?: string } } = $props()

const id = $derived(decodeURIComponent(params.id ?? ""))
const env = $derived(environments.byId(id))
let selectedTab = $state(0)
let deleting = $state<Environment | null>(null)

const op = $derived(env?.operation)
const showSteps = $derived(
  !!op &&
    (env?.state === "busy" ||
      env?.state === "failed" ||
      op.state === "cancelled" ||
      (op.kind === "create" && op.state === "running")),
)
const error = $derived(env ? currentError(env) : undefined)
const cancelled = $derived(op?.state === "cancelled" ? op.error : undefined)
const heading = $derived.by(() => {
  if (!env) return id
  if (env.state === "busy" && op?.kind === "create")
    return `Setting up ${env.name}`
  if (env.state === "busy" && op?.kind === "start")
    return `Starting ${env.name}`
  return env.name
})

function act(e: UserError | undefined): void {
  if (!env || !e) return
  switch (e.action) {
    case "open-settings":
      window.location.hash = "#/settings/computer"
      break
    case "copy-diagnostics":
      void attempt("Could not copy diagnostics", () =>
        api().copyDiagnostics(env.id),
      )
      break
    default:
      // "sign-in-retry" and "retry": starting again triggers the sign-in
      // (docker-credential-icr opens the browser) and repeats the operation.
      void environments.start(env.id)
  }
}

function actionLabel(e: UserError): string {
  switch (e.action) {
    case "sign-in-retry":
      return "Sign in and retry"
    case "open-settings":
      return "Open settings"
    case "copy-diagnostics":
      return "Copy diagnostics"
    default:
      return "Retry"
  }
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
}
</script>

<div class="sh-page">
  <Breadcrumb noTrailingSlash>
    <BreadcrumbItem href="#/">Environments</BreadcrumbItem>
    <BreadcrumbItem isCurrentPage>{env?.name ?? id}</BreadcrumbItem>
  </Breadcrumb>

  {#if !environments.loaded}
    <p class="sh-muted">Loading…</p>
  {:else if !env}
    <div class="sh-stack sh-gone">
      <h1>{id}</h1>
      <p>This environment does not exist (anymore).</p>
      <p><a href="#/">Back to environments</a></p>
    </div>
  {:else}
    <div class="sh-page-header sh-detail-header">
      <div class="sh-stack-tight">
        <div class="sh-title-row">
          <h1>{heading}</h1>
          <StatusTag {env} />
        </div>
        <p class="sh-muted">
          {env.repoUrl.replace(/^https:\/\//, "")} · {env.branch ?? "Default branch"} ·
          {ideLabel(env.ide)} · This computer
        </p>
      </div>
      <div class="sh-buttons">
        {#if env.state === "running"}
          <Button kind="secondary" on:click={() => environments.stop(env.id)}>Stop</Button>
          <Button on:click={() => environments.openInIde(env.id)}>
            Open in {ideLabel(env.ide)}
          </Button>
        {:else if env.state === "busy"}
          {#if op && (op.kind === "create" || op.kind === "start" || op.kind === "rebuild")}
            <Button kind="secondary" on:click={() => environments.cancel(env.id)}>
              Cancel
            </Button>
          {/if}
        {:else}
          <Button kind="danger-ghost" on:click={() => (deleting = env)}>Delete…</Button>
          {#if !error}
            <!-- With an error, the notification below carries the retry action. -->
            <Button on:click={() => environments.start(env.id)}>
              {env.state === "failed" ? "Retry" : "Start and open"}
            </Button>
          {/if}
        {/if}
      </div>
    </div>

    {#if error}
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        fullWidth
        title={error.title}
        subtitle={error.message}
        role="alert"
      >
        <svelte:fragment slot="actions">
          <NotificationActionButton on:click={() => act(error)}>
            {actionLabel(error)}
          </NotificationActionButton>
        </svelte:fragment>
      </InlineNotification>
    {:else if cancelled && env.state !== "busy"}
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        fullWidth
        title={cancelled.title}
        subtitle={cancelled.message}
      />
    {:else if env.state === "running" && op?.kind === "create" && op.state === "succeeded"}
      <InlineNotification
        kind="success"
        lowContrast
        hideCloseButton
        fullWidth
        title={`${ideLabel(env.ide)} is open.`}
        subtitle="You can close this window; the environment keeps running."
      />
    {/if}

    <Tabs bind:selected={selectedTab}>
      <Tab label="Overview" />
      <Tab label="Log" />
      <svelte:fragment slot="content">
        <TabContent>
          <div class="sh-tab">
            {#if showSteps && op}
              <OperationSteps operation={op} ide={env.ide} />
            {:else}
              <StructuredList condensed>
                <StructuredListBody>
                  <StructuredListRow>
                    <StructuredListCell noWrap>Repository</StructuredListCell>
                    <StructuredListCell>{env.repoUrl}</StructuredListCell>
                  </StructuredListRow>
                  <StructuredListRow>
                    <StructuredListCell noWrap>Branch</StructuredListCell>
                    <StructuredListCell>
                      <span class="sh-mono">{env.branch ?? "Default branch"}</span>
                    </StructuredListCell>
                  </StructuredListRow>
                  <StructuredListRow>
                    <StructuredListCell noWrap>IDE</StructuredListCell>
                    <StructuredListCell>{ideLabel(env.ide)}</StructuredListCell>
                  </StructuredListRow>
                  <StructuredListRow>
                    <StructuredListCell noWrap>Runs on</StructuredListCell>
                    <StructuredListCell>This computer</StructuredListCell>
                  </StructuredListRow>
                  <StructuredListRow>
                    <StructuredListCell noWrap>Created</StructuredListCell>
                    <StructuredListCell>{formatDate(env.createdAt)}</StructuredListCell>
                  </StructuredListRow>
                  <StructuredListRow>
                    <StructuredListCell noWrap>Last used</StructuredListCell>
                    <StructuredListCell>{relativeTime(env.lastUsedAt)}</StructuredListCell>
                  </StructuredListRow>
                </StructuredListBody>
              </StructuredList>
              <div class="sh-secondary-actions">
                <Button
                  kind="ghost"
                  disabled={env.state !== "running"}
                  on:click={() => environments.openTerminal(env.id)}
                >
                  Open terminal
                </Button>
                <Button kind="ghost" on:click={() => environments.rebuild(env.id)}>
                  Rebuild
                </Button>
                <Button
                  kind="ghost"
                  on:click={() =>
                    attempt("Could not copy diagnostics", () =>
                      api().copyDiagnostics(env.id),
                    )}
                >
                  Copy diagnostics
                </Button>
                {#if env.state === "running"}
                  <Button kind="danger-ghost" on:click={() => (deleting = env)}>
                    Delete…
                  </Button>
                {/if}
              </div>
              <p class="sh-muted sh-small">
                Rebuild re-creates the environment from the repository's current
                definition. Your files in the repository are kept; anything installed
                by hand inside the environment is lost.
              </p>
            {/if}
          </div>
        </TabContent>
        <TabContent>
          <div class="sh-tab">
            <LogView id={env.id} />
          </div>
        </TabContent>
      </svelte:fragment>
    </Tabs>
  {/if}
</div>

<DeleteEnvironmentModal bind:env={deleting} returnTo="/" />

<style>
  .sh-detail-header {
    margin-top: 1rem;
  }
  .sh-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .sh-stack-tight {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sh-stack-tight p {
    margin: 0;
  }
  .sh-buttons {
    display: flex;
    gap: 1px;
    flex-wrap: wrap;
  }
  .sh-tab {
    padding: 1.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sh-secondary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .sh-small {
    font-size: 0.75rem;
    max-width: 40rem;
  }
  .sh-gone {
    margin-top: 1rem;
  }
  :global(.sh-page .bx--inline-notification) {
    max-width: none;
  }
</style>

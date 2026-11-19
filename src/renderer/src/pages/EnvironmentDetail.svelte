<script lang="ts">
import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  InlineNotification,
  ProgressIndicator,
  ProgressStep,
  Tab,
  TabContent,
  Tabs,
  Tag,
  Toggle,
} from "carbon-components-svelte"

let { params = {} }: { params?: { id?: string } } = $props()

const name = $derived(decodeURIComponent(params.id ?? "environment"))

// Spike: switch between "starting" and "error" to see both layouts.
let failed = $state(false)

const steps = [
  { label: "Checking this computer", description: "Engine, credentials, IDE" },
  { label: "Getting the repository", description: "git clone over HTTPS" },
  { label: "Downloading the image", description: "icr.io" },
  { label: "Preparing the environment", description: "devcontainer setup" },
  { label: "Opening the IDE", description: "" },
]
const current = $derived(failed ? 2 : 3)

const log = [
  "09:41:02  Checking container engine … dockerd",
  "09:41:03  Cloning https://github.ibm.com/chipdev/core-rtl (branch main)",
  "09:41:10  Pulling icr.io/chipdev/base:2.1",
].join("\n")
</script>

<div class="sh-page">
  <Breadcrumb noTrailingSlash>
    <BreadcrumbItem href="#/">Environments</BreadcrumbItem>
    <BreadcrumbItem isCurrentPage>{name}</BreadcrumbItem>
  </Breadcrumb>

  <div class="sh-page-header" style="margin-top: 1rem">
    <div style="display: flex; align-items: center; gap: 0.75rem">
      <h1>{name}</h1>
      {#if failed}
        <Tag type="red">Problem</Tag>
      {:else}
        <Tag type="blue">Starting…</Tag>
      {/if}
    </div>
    <Button kind="secondary">Cancel</Button>
  </div>

  <div style="margin-bottom: 1rem">
    <Toggle size="sm" labelText="Spike: show error state" bind:toggled={failed} />
  </div>

  {#if failed}
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title="Could not download the environment image."
      subtitle="Your IBM Cloud sign-in for icr.io has probably expired. Sign in again, then retry."
    />
  {/if}

  <Tabs>
    <Tab label="Overview" />
    <Tab label="Log" />
    <svelte:fragment slot="content">
      <TabContent>
        <div style="padding-top: 1rem">
          <ProgressIndicator vertical currentIndex={current} preventChangeOnClick>
            {#each steps as step, i (step.label)}
              <ProgressStep
                label={step.label}
                description={step.description}
                complete={i < current}
                invalid={failed && i === current}
              />
            {/each}
          </ProgressIndicator>
        </div>
      </TabContent>
      <TabContent>
        <pre class="sh-log">{log}</pre>
      </TabContent>
    </svelte:fragment>
  </Tabs>
</div>

<style>
  .sh-log {
    margin: 1rem 0 0;
    padding: 1rem;
    background: #161616;
    color: #f4f4f4;
    font-family: "IBM Plex Mono", monospace;
    font-size: 0.75rem;
    line-height: 1.125rem;
    overflow-x: auto;
  }
</style>

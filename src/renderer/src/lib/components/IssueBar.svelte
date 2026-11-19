<script lang="ts">
import {
  InlineNotification,
  NotificationActionButton,
} from "carbon-components-svelte"
import { push } from "svelte-spa-router"
import { requirements } from "../stores"

const first = $derived(requirements.issues[0])
const title = $derived.by(() => {
  if (!first) return ""
  if (requirements.issues.length > 1)
    return `${requirements.issues.length} things on this computer need attention.`
  return first.state === "missing"
    ? `${first.title} is not installed.`
    : `${first.title} needs a change.`
})
</script>

{#if first}
  <div class="sh-issue-bar" data-testid="issue-bar">
    <InlineNotification
      kind="warning"
      lowContrast
      hideCloseButton
      fullWidth
      {title}
      subtitle={requirements.issues.length > 1
        ? ""
        : first.detail.replace(/^Not installed\.\s*/, "")}
    >
      <svelte:fragment slot="actions">
        <NotificationActionButton on:click={() => push("/settings/computer")}>
          Fix in Settings
        </NotificationActionButton>
      </svelte:fragment>
    </InlineNotification>
  </div>
{/if}

<style>
  .sh-issue-bar :global(.bx--inline-notification) {
    margin: 0 0 1.5rem;
    max-width: none;
  }
</style>

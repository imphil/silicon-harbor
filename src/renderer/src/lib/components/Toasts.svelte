<script lang="ts">
import { ToastNotification } from "carbon-components-svelte"
import { notifications } from "../stores"
</script>

<div class="sh-toasts" aria-live="polite">
  {#each notifications.toasts as toast (toast.id)}
    <ToastNotification
      kind={toast.kind}
      title={toast.title}
      subtitle={toast.subtitle ?? ""}
      focusOnOpen={false}
      on:close={() => notifications.dismiss(toast.id)}
    />
  {/each}
</div>

<style>
  .sh-toasts {
    position: fixed;
    top: 3.5rem;
    right: 1rem;
    z-index: 9000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
</style>

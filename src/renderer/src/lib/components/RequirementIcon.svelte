<script lang="ts">
import type { RequirementStatus } from "$shared/api"
import { InlineLoading } from "carbon-components-svelte"
import CheckmarkFilled from "carbon-icons-svelte/lib/CheckmarkFilled.svelte"
import ErrorFilled from "carbon-icons-svelte/lib/ErrorFilled.svelte"
import WarningAltFilled from "carbon-icons-svelte/lib/WarningAltFilled.svelte"

let { state }: { state: RequirementStatus["state"] } = $props()
</script>

{#if state === "ok"}
  <CheckmarkFilled size={20} fill="#24a148" title="Ready" />
{:else if state === "warn"}
  <WarningAltFilled size={20} fill="#f1c21b" class="sh-warn-icon" title="Needs a change" />
{:else if state === "missing"}
  <ErrorFilled size={20} fill="#da1e28" title="Missing" />
{:else}
  <InlineLoading description="" iconDescription="Working" />
{/if}

<style>
  /* The yellow warning triangle needs a dark mark for contrast. */
  :global(.sh-warn-icon path[data-icon-path="inner-path"]) {
    fill: #161616;
    opacity: 1;
  }
</style>

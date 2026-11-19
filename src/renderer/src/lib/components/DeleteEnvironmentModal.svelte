<script lang="ts">
import type { Environment } from "$shared/api"
import { Modal } from "carbon-components-svelte"
import { push } from "svelte-spa-router"
import { environments } from "../stores"

let {
  env = $bindable(null),
  returnTo,
}: { env?: Environment | null; returnTo?: string } = $props()

let open = $state(false)
let target = $state<Environment | null>(null)

$effect(() => {
  if (env) {
    target = env
    open = true
  }
})

function close(): void {
  open = false
  env = null
}

async function confirm(): Promise<void> {
  const current = target
  close()
  if (!current) return
  await environments.remove(current.id)
  if (returnTo) void push(returnTo)
}
</script>

<Modal
  bind:open
  danger
  size="sm"
  modalLabel={target?.name ?? ""}
  modalHeading="Delete this environment?"
  aria-label={`Delete ${target?.name ?? "this environment"}?`}
  primaryButtonText="Delete"
  secondaryButtonText="Cancel"
  on:click:button--secondary={close}
  on:close={close}
  on:submit={confirm}
>
  <p>
    This removes <strong>{target?.name}</strong> from this computer. Changes you have
    not pushed to github.ibm.com are lost. The repository itself is not affected.
  </p>
</Modal>

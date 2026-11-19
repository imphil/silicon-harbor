<script lang="ts">
import { checkRepoUrl } from "$shared/repo-url"
import { Modal, Select, SelectItem, TextInput } from "carbon-components-svelte"
import { push } from "svelte-spa-router"

let { open = $bindable(false) }: { open?: boolean } = $props()

let url = $state("")
let ide = $state("vscode")

const check = $derived(checkRepoUrl(url))
const errorText = $derived.by(() => {
  if (check.ok || check.reason === "empty") return ""
  return check.reason === "ssh"
    ? "Use the HTTPS address. SSH addresses are not supported."
    : "This does not look like a repository address, for example https://github.ibm.com/org/repo"
})

function create(): void {
  if (!check.ok) return
  open = false
  void push(`/environments/${encodeURIComponent(check.name)}`)
}
</script>

<Modal
  bind:open
  modalLabel="New environment"
  modalHeading="Start from a Git repository"
  primaryButtonText="Create and open"
  primaryButtonDisabled={!check.ok}
  secondaryButtonText="Cancel"
  selectorPrimaryFocus="#sh-repo-url"
  on:click:button--secondary={() => (open = false)}
  on:submit={create}
>
  <div class="sh-stack">
    <TextInput
      id="sh-repo-url"
      labelText="Git repository URL"
      placeholder="https://github.ibm.com/org/repo"
      helperText="The HTTPS address you would use for git clone."
      invalid={errorText !== ""}
      invalidText={errorText}
      bind:value={url}
    />
    <Select labelText="Open with" bind:selected={ide}>
      <SelectItem value="vscode" text="VS Code" />
      <SelectItem value="bob" text="IBM Bob" />
      <SelectItem value="codium" text="VSCodium" />
    </Select>
    {#if check.ok}
      <p class="sh-muted">Environment name: <span class="sh-mono">{check.name}</span></p>
    {/if}
  </div>
</Modal>

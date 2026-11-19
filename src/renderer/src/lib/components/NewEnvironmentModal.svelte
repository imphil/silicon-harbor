<script lang="ts">
import type { IdeId } from "$shared/api"
import { checkRepoUrl } from "$shared/repo-url"
import {
  Accordion,
  AccordionItem,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  TextInput,
} from "carbon-components-svelte"
import { push } from "svelte-spa-router"
import { environments, settings } from "../stores"
import { ideLabels, ideOrder } from "../view"

let { open = $bindable(false) }: { open?: boolean } = $props()

let url = $state("")
let branch = $state("")
let name = $state("")
let ide = $state<IdeId>("vscode")
let submitting = $state(false)
let touched = $state(false)

const check = $derived(checkRepoUrl(url))
const errorText = $derived.by(() => {
  if (check.ok || check.reason === "empty") return ""
  if (!touched && check.reason === "invalid") return ""
  return check.reason === "ssh"
    ? "Use the HTTPS address. SSH addresses are not supported."
    : "This does not look like a repository address, for example https://github.ibm.com/org/repo"
})
const derivedName = $derived(check.ok ? check.name : "")
const summary = $derived(
  [
    branch.trim() || "Default branch",
    name.trim() || derivedName || "Name from the address",
    ideLabels[ide],
    "This computer",
  ].join(" · "),
)

// Reset the form every time the dialog opens.
$effect(() => {
  if (open) {
    url = ""
    branch = ""
    name = ""
    touched = false
    submitting = false
    ide = settings.value.defaultIde
  }
})

async function create(): Promise<void> {
  touched = true
  if (!check.ok || submitting) return
  submitting = true
  const result = await environments.create({
    repoUrl: url.trim(),
    branch: branch.trim() || undefined,
    name: name.trim() || undefined,
    ide,
  })
  submitting = false
  if (!result) return
  open = false
  void push(`/environments/${encodeURIComponent(result.id)}`)
}
</script>

<Modal
  bind:open
  modalLabel="New environment"
  modalHeading="Start from a Git repository"
  primaryButtonText={submitting ? "Creating…" : "Create and open"}
  primaryButtonDisabled={!check.ok || submitting}
  secondaryButtonText="Cancel"
  selectorPrimaryFocus="#sh-repo-url"
  hasForm
  on:click:button--secondary={() => (open = false)}
  on:submit={create}
>
  <div class="sh-stack">
    <TextInput
      id="sh-repo-url"
      labelText="Git repository URL"
      placeholder="https://github.ibm.com/org/repo"
      helperText="The HTTPS address you would use for git clone. You sign in with your usual github.ibm.com login."
      invalid={errorText !== ""}
      invalidText={errorText}
      bind:value={url}
      on:blur={() => (touched = true)}
    />

    <Accordion>
      <AccordionItem>
        <svelte:fragment slot="title">
          <span>Options</span>
          <span class="sh-muted sh-summary" data-testid="options-summary">{summary}</span>
        </svelte:fragment>
        <div class="sh-options">
          <TextInput
            id="sh-branch"
            labelText="Branch"
            placeholder="Default branch"
            bind:value={branch}
          />
          <TextInput
            id="sh-name"
            labelText="Name"
            placeholder={derivedName || "Derived from the address"}
            bind:value={name}
          />
          <Select id="sh-ide" labelText="Open with" bind:selected={ide}>
            {#each ideOrder as id (id)}
              <SelectItem value={id} text={ideLabels[id]} />
            {/each}
          </Select>
          <RadioButtonGroup
            legendText="Run on"
            name="sh-run-on"
            selected="local"
            orientation="vertical"
          >
            <RadioButton value="local" labelText="This computer" />
            <RadioButton
              value="remote"
              labelText="Remote machine (coming later)"
              disabled
            />
          </RadioButtonGroup>
        </div>
      </AccordionItem>
    </Accordion>
  </div>
</Modal>

<style>
  .sh-summary {
    margin-left: 1rem;
    font-size: 0.75rem;
  }
  .sh-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    padding-top: 0.5rem;
  }
</style>

<script lang="ts">
import { Button } from "carbon-components-svelte"
import { push } from "svelte-spa-router"
import RequirementsList from "../lib/components/RequirementsList.svelte"
import { requirements, settings } from "../lib/stores"

async function finish(): Promise<void> {
  await settings.update({ firstRunDone: true })
  void push("/")
}
</script>

<div class="sh-page sh-first-run">
  <div class="sh-intro">
    <h1>Set up your machine</h1>
    <p class="sh-muted">
      Silicon Harbor checks the tools needed to run development environments on this
      computer. Nothing is installed or changed until you click a button.
    </p>
  </div>

  <RequirementsList showFixAll />

  <div class="sh-continue">
    {#if requirements.allOk}
      <Button on:click={finish}>Continue</Button>
    {:else}
      <Button kind="ghost" on:click={finish}>Skip for now</Button>
    {/if}
  </div>
</div>

<style>
  .sh-first-run {
    max-width: 60rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .sh-intro {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sh-intro h1 {
    margin: 0;
    font-size: 2rem;
    line-height: 2.5rem;
    font-weight: 400;
  }
  .sh-intro p {
    margin: 0;
    max-width: 40rem;
  }
  .sh-continue {
    display: flex;
    justify-content: flex-end;
  }
</style>

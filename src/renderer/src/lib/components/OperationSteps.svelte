<script lang="ts">
import type { IdeId, Operation } from "$shared/api"
import { ProgressIndicator, ProgressStep } from "carbon-components-svelte"
import { stepLabel } from "../view"

let { operation, ide }: { operation: Operation; ide: IdeId } = $props()

const visible = $derived(operation.steps.filter((s) => s.state !== "skipped"))
// ProgressIndicator marks the step at currentIndex as current; point past the
// end when nothing is running so finished steps don't look in progress.
const currentIndex = $derived.by(() => {
  const i = visible.findIndex(
    (s) => s.state === "active" || s.state === "failed",
  )
  return i >= 0 ? i : visible.length
})

const stateText: Record<string, string> = {
  done: "Done",
  active: "In progress",
  failed: "Failed",
  pending: "Not started",
}
</script>

<ProgressIndicator vertical preventChangeOnClick {currentIndex}>
  {#each visible as step (step.id)}
    <ProgressStep
      label={stepLabel(step.id, ide)}
      secondaryLabel={step.detail ?? ""}
      description={stateText[step.state]}
      complete={step.state === "done"}
      current={step.state === "active"}
      invalid={step.state === "failed"}
      data-testid={`step-${step.id}`}
      data-state={step.state}
    />
  {/each}
</ProgressIndicator>

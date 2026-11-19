<script lang="ts">
import type { LogLine } from "$shared/api"
import { api } from "../api"

let { id }: { id: string } = $props()

let lines = $state<LogLine[]>([])
let error = $state("")
let box = $state<HTMLPreElement | undefined>()

$effect(() => {
  const envId = id
  let cancelled = false
  const pending: LogLine[] = []
  let loaded = false
  const unsubscribe = api().onLog(envId, (line) => {
    if (loaded) lines = [...lines, line]
    else pending.push(line)
  })
  api()
    .getLog(envId)
    .then((initial) => {
      if (cancelled) return
      lines = [...initial, ...pending]
      loaded = true
    })
    .catch((e: unknown) => {
      error = e instanceof Error ? e.message : String(e)
      loaded = true
    })
  return () => {
    cancelled = true
    unsubscribe()
  }
})

// Keep the newest line visible.
$effect(() => {
  void lines.length
  if (box) box.scrollTop = box.scrollHeight
})

function time(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString()
}
</script>

{#if error}
  <p class="sh-muted">The log is not available: {error}</p>
{:else if lines.length === 0}
  <p class="sh-muted">Nothing logged yet.</p>
{:else}
  <!-- Scrollable regions must be keyboard-focusable (WCAG 2.1.1). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre
    bind:this={box}
    class="sh-log"
    aria-label="Log"
    tabindex="0"
    data-testid="log">{#each lines as line, i (i)}<span class:sh-log-error={line.level === "error"} class:sh-log-warn={line.level === "warn"}>{time(line.ts)}  {line.text}
</span>{/each}</pre>
{/if}

<style>
  .sh-log {
    margin: 0;
    max-height: 24rem;
    overflow: auto;
    padding: 1rem;
    background: #161616;
    color: #f4f4f4;
    font-family: "IBM Plex Mono", monospace;
    font-size: 0.75rem;
    line-height: 1.125rem;
    white-space: pre-wrap;
  }
  .sh-log:focus {
    outline: 2px solid var(--cds-focus, #0f62fe);
    outline-offset: -2px;
  }
  .sh-log-error {
    color: #ffb3b8;
  }
  .sh-log-warn {
    color: #f1c21b;
  }
</style>

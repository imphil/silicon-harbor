<script lang="ts">
import type { Environment } from "$shared/api"
import { Tag } from "carbon-components-svelte"
import { statusView } from "../view"

let { env }: { env: Environment } = $props()

const view = $derived(statusView(env))
</script>

<Tag type={view.tag} size="sm" data-testid="status-tag">{view.label}</Tag>

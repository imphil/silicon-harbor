<script lang="ts">
import {
  Content,
  Header,
  HeaderNav,
  HeaderNavItem,
  HeaderUtilities,
  Loading,
  SkipToContent,
} from "carbon-components-svelte"
import CheckmarkFilled from "carbon-icons-svelte/lib/CheckmarkFilled.svelte"
import Help from "carbon-icons-svelte/lib/Help.svelte"
import WarningAltFilled from "carbon-icons-svelte/lib/WarningAltFilled.svelte"
import Router, { router } from "svelte-spa-router"
import Toasts from "./lib/components/Toasts.svelte"
import { environments, requirements, settings } from "./lib/stores"
import EnvironmentDetail from "./pages/EnvironmentDetail.svelte"
import Environments from "./pages/Environments.svelte"
import FirstRun from "./pages/FirstRun.svelte"
import NotFound from "./pages/NotFound.svelte"
import Settings from "./pages/Settings.svelte"

const routes = {
  "/": Environments,
  "/environments/:id": EnvironmentDetail,
  "/settings/:section?": Settings,
  "*": NotFound,
}

$effect(() => {
  void settings.init()
  void environments.init()
  void requirements.init()
  return () => {
    environments.dispose()
    requirements.dispose()
  }
})

const firstRun = $derived(settings.loaded && !settings.value.firstRunDone)

// svelte-spa-router 5 exposes a rune-based `router` object, not a store.
const inSettings = $derived(router.location.startsWith("/settings"))

const issueCount = $derived(requirements.issues.length)
// "unknown" when the check itself failed: never claim "Ready" without a result.
const health = $derived(
  requirements.loadError ? "unknown" : issueCount === 0 ? "ready" : "issues",
)
const healthLabel = $derived(
  health === "unknown"
    ? "Not checked"
    : health === "ready"
      ? "Ready"
      : issueCount === 1
        ? "1 issue"
        : `${issueCount} issues`,
)
const healthTitle = $derived(
  health === "unknown"
    ? "This computer could not be checked. Open Settings for details."
    : health === "ready"
      ? "This computer is ready"
      : `${healthLabel} on this computer. Open Settings to fix.`,
)
</script>

<Header
  theme="classic"
  uiShellAriaLabel="Silicon Harbor"
  platformName="Silicon Harbor"
  href="#/"
>
  <svelte:fragment slot="skipToContent">
    <SkipToContent />
  </svelte:fragment>
  {#if settings.loaded && !firstRun}
    <HeaderNav aria-label="Main">
      <HeaderNavItem href="#/" text="Environments" isSelected={!inSettings} />
      <HeaderNavItem href="#/settings" text="Settings" isSelected={inSettings} />
    </HeaderNav>
    <HeaderUtilities>
      {#if requirements.loaded}
        <a
          class="sh-health"
          class:sh-health-issue={health === "issues"}
          href="#/settings/computer"
          title={healthTitle}
          data-testid="health"
        >
          {#if health === "ready"}
            <CheckmarkFilled fill="#42be65" />
          {:else if health === "unknown"}
            <Help fill="#c6c6c6" />
          {:else}
            <WarningAltFilled fill="#f1c21b" class="sh-warn-icon" />
          {/if}
          <span>{healthLabel}</span>
        </a>
      {/if}
    </HeaderUtilities>
  {:else if firstRun}
    <HeaderUtilities>
      <span class="sh-health">Setup</span>
    </HeaderUtilities>
  {/if}
</Header>

<Content>
  {#if !settings.loaded}
    <Loading withOverlay={false} description="Loading" />
  {:else if firstRun}
    <FirstRun />
  {:else}
    <Router {routes} />
  {/if}
</Content>

<Toasts />

<style>
  .sh-health {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 3rem;
    padding: 0 1rem;
    color: #c6c6c6;
    font-size: 0.75rem;
    text-decoration: none;
  }
  a.sh-health:hover {
    background: #353535;
    color: #f4f4f4;
  }
  a.sh-health:focus {
    outline: 2px solid #ffffff;
    outline-offset: -2px;
  }
  .sh-health-issue {
    color: #f4f4f4;
  }
  :global(.sh-warn-icon path[data-icon-path="inner-path"]) {
    fill: #161616;
    opacity: 1;
  }
</style>

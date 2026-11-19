<script lang="ts">
import {
  Content,
  Header,
  HeaderNav,
  HeaderNavItem,
  HeaderUtilities,
  SkipToContent,
} from "carbon-components-svelte"
import CheckmarkFilled from "carbon-icons-svelte/lib/CheckmarkFilled.svelte"
import WarningAltFilled from "carbon-icons-svelte/lib/WarningAltFilled.svelte"
import Router, { router } from "svelte-spa-router"
import SettingsNav from "./lib/components/SettingsNav.svelte"
import EnvironmentDetail from "./pages/EnvironmentDetail.svelte"
import Environments from "./pages/Environments.svelte"
import NotFound from "./pages/NotFound.svelte"
import Settings from "./pages/Settings.svelte"

const routes = {
  "/": Environments,
  "/environments/:id": EnvironmentDetail,
  "/settings/:section?": Settings,
  "*": NotFound,
}

// Spike: a fake health state so both header variants can be inspected.
let healthy = $state(false)
let isSideNavOpen = $state(true)

// svelte-spa-router 5 exposes a rune-based `router` object, not a store.
const inSettings = $derived(router.location.startsWith("/settings"))
const settingsSection = $derived(router.location.split("/")[2] || "computer")
</script>

<Header
  companyName="IBM"
  platformName="Silicon Harbor"
  href="#/"
  bind:isSideNavOpen
  persistentHamburgerMenu={false}
>
  <svelte:fragment slot="skipToContent">
    <SkipToContent />
  </svelte:fragment>
  <HeaderNav>
    <HeaderNavItem
      href="#/"
      text="Environments"
      isSelected={!inSettings}
    />
    <HeaderNavItem href="#/settings" text="Settings" isSelected={inSettings} />
  </HeaderNav>
  <HeaderUtilities>
    <a
      class="sh-health"
      href="#/settings/computer"
      title={healthy ? "This computer is ready" : "1 issue on this computer"}
    >
      {#if healthy}
        <CheckmarkFilled fill="#42be65" />
        <span>Ready</span>
      {:else}
        <WarningAltFilled fill="#f1c21b" />
        <span>1 issue</span>
      {/if}
    </a>
  </HeaderUtilities>
</Header>

{#if inSettings}
  <SettingsNav section={settingsSection} bind:isOpen={isSideNavOpen} />
{/if}

<Content>
  <Router {routes} />
</Content>

<style>
  .sh-health {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 3rem;
    padding: 0 1rem;
    color: var(--cds-text-secondary, #525252);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .sh-health:hover {
    background: var(--cds-layer-hover, #e5e5e5);
    color: var(--cds-text-primary, #161616);
  }
  .sh-health:focus {
    outline: 2px solid var(--cds-focus, #0f62fe);
    outline-offset: -2px;
  }
</style>

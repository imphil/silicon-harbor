<script lang="ts">
import { SideNav, SideNavItems, SideNavLink } from "carbon-components-svelte"
import { settingsSections } from "../settings-sections"

let {
  section,
  isOpen = $bindable(true),
}: { section: string; isOpen?: boolean } = $props()
</script>

<SideNav bind:isOpen ariaLabel="Settings sections">
  <SideNavItems>
    {#each settingsSections as s (s.id)}
      <SideNavLink
        href={`#/settings/${s.id}`}
        text={s.label}
        isSelected={section === s.id}
      />
    {/each}
  </SideNavItems>
</SideNav>

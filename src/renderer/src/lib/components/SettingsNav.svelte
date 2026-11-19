<script lang="ts">
import { settingsSections } from "../settings-sections"

let { section }: { section: string } = $props()
</script>

<nav class="sh-subnav" aria-label="Settings sections">
  <ul>
    {#each settingsSections as s (s.id)}
      <li>
        <a
          href={`#/settings/${s.id}`}
          class:sh-subnav-on={section === s.id}
          aria-current={section === s.id ? "page" : undefined}
        >
          {s.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .sh-subnav ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sh-subnav a {
    display: flex;
    align-items: center;
    height: 2.5rem;
    padding: 0 1rem;
    border-left: 3px solid transparent;
    color: var(--cds-text-secondary, #525252);
    font-size: 0.875rem;
    text-decoration: none;
  }
  .sh-subnav a:hover {
    background: var(--cds-layer-hover-01, #e8e8e8);
    color: var(--cds-text-primary, #161616);
  }
  .sh-subnav a:focus {
    outline: 2px solid var(--cds-focus, #0f62fe);
    outline-offset: -2px;
  }
  .sh-subnav a.sh-subnav-on {
    background: var(--cds-layer-selected-01, #e0e0e0);
    color: var(--cds-text-primary, #161616);
    font-weight: 600;
    border-left-color: var(--cds-interactive, #0f62fe);
  }
</style>

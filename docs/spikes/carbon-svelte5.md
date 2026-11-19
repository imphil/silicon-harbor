# Spike: carbon-components-svelte with Svelte 5

Date: 2026-11-19 · carbon-components-svelte 0.114.3 · carbon-icons-svelte 13.18.0 · svelte 5.57.2

## Question

`carbon-components-svelte` is written in Svelte 4 syntax (`export let`, slots,
`createEventDispatcher`). Can a Svelte 5 app written in runes mode use it without
friction?

## What was built

The hello-world UI in `src/renderer` uses runes in every page and component
(`$props`, `$state`, `$derived`, `$effect`, `$bindable`) and exercises:

| Component                                                        | Where                        | Interop pattern exercised                                                             |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Header, HeaderNav, HeaderNavItem, HeaderUtilities, SkipToContent | `App.svelte`                 | named slot (`slot="skipToContent"`), `bind:isSideNavOpen`                             |
| SideNav, SideNavItems, SideNavLink                               | `SettingsNav.svelte`         | `bind:isOpen` into a `$bindable` prop                                                 |
| Content                                                          | `App.svelte`                 | default slot                                                                          |
| DataTable with custom cells                                      | `Environments.svelte`        | `<svelte:fragment slot="cell" let:row let:cell>`, typed headers                       |
| OverflowMenu, OverflowMenuItem                                   | `Environments.svelte`        | component events via `on:click`                                                       |
| Button, Toggle, Tag, EmptyState                                  | `Environments.svelte`        | `on:click`, `bind:toggled`                                                            |
| Modal, TextInput, Select, SelectItem                             | `NewEnvironmentModal.svelte` | `bind:open`, `bind:value`, `bind:selected`, `on:submit`, `on:click:button--secondary` |
| Tabs, Tab, TabContent                                            | `EnvironmentDetail.svelte`   | `slot="content"` fragment                                                             |
| ProgressIndicator, ProgressStep                                  | `EnvironmentDetail.svelte`   | `{#each}` children                                                                    |
| InlineNotification                                               | detail + settings            | props only                                                                            |
| TileGroup, RadioTile                                             | `Settings.svelte`            | `bind:selected`                                                                       |
| StructuredList*                                                  | `Settings.svelte`            | nested default slots                                                                  |

## Results

- **svelte-check: 0 errors, 0 warnings.** Legacy syntax used _on_ legacy
  components from runes components (`on:event`, `let:`, `slot="…"`) produces no
  deprecation warnings.
- **Build: clean** (electron-vite / Vite 7). No Svelte compiler warnings.
- **Runtime:** Playwright smoke test (`e2e/smoke.e2e.ts`) drives header nav,
  DataTable, modal validation + submit, IPC and settings nav in real Electron,
  with zero console errors.
- **Visual check:** screenshots of all screens look like Carbon; the SideNav
  correctly offsets `Content`.

## Problems found and fixed

1. **IBM Plex loaded from IBM's CDN.** The precompiled `css/white.css` declares
   every Plex face with `https://1.www.s81c.com/...` URLs. Our CSP
   (`font-src 'self'`) blocks them → dozens of console errors, and the app would
   need network for fonts. Fix: a tiny Vite plugin (`electron.vite.config.ts`,
   `stripCarbonCdnFonts`) removes those `@font-face` rules at build time, and
   `src/renderer/src/fonts.css` bundles the weights we use from `@ibm/plex`
   (Sans 300/400/400i/600, Mono 400; ~310 kB).
2. **svelte-spa-router 5 is runes-based.** There is no `location` store any
   more; use the reactive `router.location` object. (Devsy uses the same.)
3. **Slot name changed:** Header's skip-link slot is `skipToContent`, not
   `skip-to-content` as in older docs.
4. **DataTable headers need explicit typing** (`DataTableHeader<Row>[]`, import
   from `carbon-components-svelte/src/DataTable/DataTable.svelte`), otherwise
   TypeScript widens the union and svelte-check fails.

## Things to know

- **Carbon generation:** class names are `bx--` (Carbon v10 naming) while CSS
  custom properties are v11 tokens (`--cds-text-primary`, `--cds-text-secondary`,
  `--cds-layer-hover`, `--cds-focus`). Use v11 token names in our own CSS.
- **Header is light in the White theme.** The mockups show a dark (g100) shell.
  `theme="classic"` had no visible effect. Options: accept the light header,
  or load `g100.css` scoped to the header (not tried). Decide in M3.
- **Bundle size:** renderer JS ~970 kB, CSS ~745 kB (full Carbon). Irrelevant
  for a local Electron app; `carbon-preprocess-svelte` (`optimizeImports`,
  `optimizeCss`) can shrink it later if wanted.
- **Telemetry:** `carbon-components-svelte` and `@ibm/plex` run
  `ibmtelemetry` in `postinstall`. npm 11 did not run those scripts here
  (not in `allowScripts`); CI sets `IBM_TELEMETRY_DISABLED=true` anyway.
- **Electron binary:** Electron ≥ 42 no longer downloads its binary on install;
  `postinstall: install-electron` handles it (same as Devsy).
- **Running Electron from this VS Code session:** the extension host exports
  `ELECTRON_RUN_AS_NODE=1`; unset it (`env -u ELECTRON_RUN_AS_NODE …`) before
  `npm run dev` or Playwright, otherwise Electron starts as plain Node.

## Verdict

**Go.** carbon-components-svelte works from Svelte 5 runes code without
warnings or workarounds beyond the font fix. The only open design point is the
header theme.

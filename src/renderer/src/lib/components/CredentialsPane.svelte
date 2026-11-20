<script lang="ts">
import type {
  ArtifactoryCredential,
  GitHubCredential,
  RequirementStatus,
} from "$shared/api"
import {
  Button,
  CopyButton,
  InlineLoading,
  InlineNotification,
  Link,
  ListItem,
  OrderedList,
  PasswordInput,
  Tag,
  TextInput,
} from "carbon-components-svelte"
import { credentials } from "../stores"
import RequirementIcon from "./RequirementIcon.svelte"

/** Settings › Credentials: what environments can sign in with, and its state. */

$effect(() => {
  void credentials.init()
})

const github = $derived(credentials.status?.github)
const artifactory = $derived(credentials.status?.artifactory)
const signIn = $derived(github?.signIn)

function githubIcon(g: GitHubCredential): RequirementStatus["state"] {
  if (g.signIn) return "working"
  if (g.state === "ok") return "ok"
  return g.state === "unknown" || g.state === "invalid" ? "warn" : "missing"
}

function artifactoryIcon(a: ArtifactoryCredential): RequirementStatus["state"] {
  if (a.state === "ok") return "ok"
  return a.state === "missing" ? "missing" : "warn"
}

const stateLabel: Record<string, string> = {
  ok: "Working",
  "no-cli": "Not installed",
  "signed-out": "Not signed in",
  missing: "No token",
  invalid: "Rejected",
  unknown: "Not checked",
}
const tagType = (state: string) =>
  state === "ok"
    ? "green"
    : state === "unknown"
      ? "gray"
      : state === "invalid"
        ? "red"
        : "magenta"

// Artifactory form ------------------------------------------------------

let editing = $state(false)
let user = $state("")
let token = $state("")
let userTouched = $state(false)

const stored = $derived(
  artifactory !== undefined && artifactory.state !== "missing",
)
const showForm = $derived(
  artifactory !== undefined &&
    (artifactory.state === "missing" ||
      artifactory.state === "invalid" ||
      editing),
)
const canSave = $derived(
  !credentials.saving && user.trim() !== "" && (token.trim() !== "" || stored),
)

// Prefill the w3id: the stored one, else the GitHub account's email address.
$effect(() => {
  if (userTouched) return
  user = artifactory?.user ?? github?.account?.email ?? ""
})

async function save(): Promise<void> {
  const saved = await credentials.saveArtifactory({ user, token })
  if (saved) {
    token = ""
    editing = false
  }
}

function cancelEdit(): void {
  editing = false
  token = ""
  userTouched = false
}
</script>

<div class="sh-creds">
  {#if credentials.loadError}
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title="Could not check the credentials."
      subtitle={credentials.loadError}
    />
  {/if}

  {#if !credentials.status}
    <InlineLoading description="Checking your sign-ins…" />
  {:else}
    {#if github}
      <section class="sh-cred" aria-labelledby="sh-cred-github" data-testid="cred-github">
        <header class="sh-cred-head">
          <RequirementIcon state={githubIcon(github)} />
          <h3 id="sh-cred-github">GitHub <span class="sh-mono sh-muted">{github.host}</span></h3>
          <Tag size="sm" type={tagType(github.state)}>{stateLabel[github.state] ?? github.state}</Tag>
        </header>

        <p>{github.detail}</p>
        {#if github.scopes && github.scopes.length > 0}
          <p class="sh-muted sh-small">
            Access: {github.scopes.join(", ")}
          </p>
        {/if}
        <p class="sh-muted sh-small">
          Signed in through the GitHub CLI on this computer. Environments use this sign-in
          for Git and the GitHub CLI (gh) while your IDE or a terminal is connected.
        </p>

        {#if signIn}
          <div class="sh-signin" data-testid="github-sign-in">
            {#if signIn.code}
              <p>
                Enter this code on the {github.host} page that opened in your browser, then
                confirm. It is already on your clipboard.
              </p>
              <div class="sh-code">
                <span class="sh-mono">{signIn.code}</span>
                <CopyButton text={signIn.code} feedback="Copied" iconDescription="Copy the code" />
              </div>
              <div class="sh-buttons">
                {#if signIn.url}
                  <Button kind="tertiary" size="small" href={signIn.url} target="_blank" rel="noreferrer">
                    Open {github.host}
                  </Button>
                {/if}
                <Button kind="ghost" size="small" on:click={() => credentials.cancelGitHubSignIn()}>
                  Cancel
                </Button>
              </div>
              <InlineLoading description="Waiting for you to confirm in the browser…" />
            {:else}
              <InlineLoading description="Starting the sign-in…" />
            {/if}
          </div>
        {:else}
          <div class="sh-buttons">
            {#if github.state === "no-cli"}
              <Button kind="tertiary" size="small" href="#/settings/computer">
                Install on This computer
              </Button>
            {:else if github.state === "ok"}
              <Button kind="ghost" size="small" on:click={() => credentials.signInGitHub()}>
                Sign in again
              </Button>
            {:else}
              <Button kind="primary" size="small" on:click={() => credentials.signInGitHub()}>
                Sign in
              </Button>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    {#if artifactory}
      <section class="sh-cred" aria-labelledby="sh-cred-artifactory" data-testid="cred-artifactory">
        <header class="sh-cred-head">
          <RequirementIcon state={artifactoryIcon(artifactory)} />
          <h3 id="sh-cred-artifactory">
            Artifactory <span class="sh-mono sh-muted">{new URL(artifactory.url).host}</span>
          </h3>
          <Tag size="sm" type={tagType(artifactory.state)}>
            {stateLabel[artifactory.state] ?? artifactory.state}
          </Tag>
        </header>

        <p>
          {artifactory.detail}
          {#if artifactory.user}<span class="sh-muted">w3id: {artifactory.user}</span>{/if}
        </p>
        <p class="sh-muted sh-small">
          Environments get the token at <span class="sh-mono">/run/secrets/ARTIFACTORY_TOKEN</span>
          and your w3id at <span class="sh-mono">/run/secrets/IBM_USER</span> when they start. A
          change reaches running environments at their next start. An environment created
          before the first token was saved is recreated once at its next start; changes
          outside its source folder are lost then.
        </p>

        {#if showForm}
          <div class="sh-form">
            <p>Artifactory has no sign-in Silicon Harbor can open for you. Create a token by hand:</p>
            <OrderedList>
              <ListItem>
                Open <Link href={artifactory.url} target="_blank" rel="noreferrer">{new URL(artifactory.url).host}</Link>
                and log in with your w3id.
              </ListItem>
              <ListItem>
                Click the icon with your initial at the top right, then choose <strong>Edit Profile</strong>.
              </ListItem>
              <ListItem>Click <strong>Generate an Identity Token</strong>.</ListItem>
              <ListItem>Enter <strong>Silicon Harbor</strong> as the description and click <strong>Next</strong>.</ListItem>
              <ListItem>Copy the reference token that is shown and paste it below.</ListItem>
            </OrderedList>
            <TextInput
              labelText="w3id (your IBM email address)"
              placeholder="name@ibm.com"
              bind:value={user}
              on:input={() => (userTouched = true)}
            />
            <PasswordInput
              labelText="Identity token"
              placeholder={stored ? "Leave empty to keep the stored token" : "Paste the token"}
              bind:value={token}
              hidePasswordLabel="Hide token"
              showPasswordLabel="Show token"
            />
            <div class="sh-buttons">
              <Button kind="primary" size="small" disabled={!canSave} on:click={save}>
                {credentials.saving ? "Checking…" : "Save and check"}
              </Button>
              {#if editing}
                <Button kind="ghost" size="small" on:click={cancelEdit}>Cancel</Button>
              {/if}
              {#if stored && !editing}
                <Button kind="danger-ghost" size="small" on:click={() => credentials.removeArtifactory()}>
                  Remove token
                </Button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="sh-buttons">
            <Button kind="tertiary" size="small" on:click={() => (editing = true)}>
              Replace token
            </Button>
            <Button kind="danger-ghost" size="small" on:click={() => credentials.removeArtifactory()}>
              Remove token
            </Button>
          </div>
        {/if}
      </section>
    {/if}
  {/if}

  <div class="sh-buttons sh-end">
    <Button
      kind="secondary"
      disabled={credentials.checking || credentials.signingIn}
      on:click={() => credentials.check()}
    >
      {credentials.checking ? "Checking…" : "Check again"}
    </Button>
  </div>
</div>

<style>
  .sh-creds {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sh-cred {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--cds-layer-01, #f4f4f4);
    border-bottom: 1px solid var(--cds-border-subtle-01, #e0e0e0);
  }
  .sh-cred p {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.25rem;
  }
  .sh-cred-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .sh-cred-head h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }
  .sh-cred-head h3 .sh-mono {
    font-weight: 400;
    font-size: 0.8125rem;
    margin-left: 0.5rem;
  }
  .sh-signin,
  .sh-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--cds-layer-02, #ffffff);
  }
  .sh-code {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sh-code .sh-mono {
    font-size: 1.75rem;
    letter-spacing: 0.1em;
  }
  .sh-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .sh-end {
    justify-content: flex-end;
  }
  .sh-small {
    font-size: 0.75rem;
  }
</style>

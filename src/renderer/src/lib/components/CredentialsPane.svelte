<script lang="ts">
import type {
  ArtifactoryCredential,
  GitHubCredential,
  IbmCloudCredential,
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
import { untrack } from "svelte"
import { credentials } from "../stores"
import { checkedAgo, clock } from "../stores/clock.svelte"
import { expiresIn, relativeTime } from "../view"
import RequirementIcon from "./RequirementIcon.svelte"

/** Settings › Credentials: what environments can sign in with, and its state. */

// Each time the pane opens: the main process checks again when the last
// check is over 10 minutes old (and asks docker-credential-icr, which may
// open the IBM Cloud login).
$effect(() => {
  untrack(() => void credentials.init())
})

const github = $derived(credentials.status?.github)
const artifactory = $derived(credentials.status?.artifactory)
const ibmCloud = $derived(credentials.status?.ibmCloud)
const signIn = $derived(github?.signIn)

function githubIcon(g: GitHubCredential): RequirementStatus["state"] {
  if (g.signIn) return "working"
  if (g.state === "ok") return "ok"
  return g.state === "unknown" || g.state === "invalid" ? "warn" : "missing"
}

function ibmCloudIcon(c: IbmCloudCredential): RequirementStatus["state"] {
  if (c.signingIn) return "working"
  if (c.state === "ok") return "ok"
  return c.state === "unknown" ? "warn" : "missing"
}

function artifactoryIcon(a: ArtifactoryCredential): RequirementStatus["state"] {
  if (a.state === "ok") return "ok"
  return a.state === "missing" ? "missing" : "warn"
}

const stateLabel: Record<string, string> = {
  ok: "Working",
  "no-cli": "Not installed",
  "no-helper": "Not installed",
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

// Prefill the w3id: the stored one, else the github.ibm.com account's email address.
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
          <h3 id="sh-cred-github">{github.host}</h3>
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
          for Git and the GitHub CLI (gh): in their setup steps, and while your IDE or a
          terminal is connected. They also find the token in
          <span class="sh-mono">/run/secrets/GITHUB_IBM_COM_TOKEN</span> for tools that read a file.
        </p>
        <p class="sh-muted sh-small" data-testid="github-checked">
          {checkedAgo(github.checkedAt, relativeTime)}
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
        {#if artifactory.tokenExpiresAt}
          <p class="sh-small" data-testid="artifactory-expiry">
            The token in your environments {expiresIn(artifactory.tokenExpiresAt, clock.now)};
            Silicon Harbor replaces it after half its lifetime.
            {#if artifactory.parentExpiresAt}
              <span class="sh-muted">
                The token it renews with, kept on this computer only,
                {expiresIn(artifactory.parentExpiresAt, clock.now)}.
              </span>
            {/if}
          </p>
        {/if}
        {#if artifactory.renewalError}
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Automatic renewal failed:"
            subtitle={`${artifactory.renewalError} Silicon Harbor tries again every hour.`}
          />
        {/if}
        <p class="sh-muted sh-small">
          Environments find the token in <span class="sh-mono">/run/secrets/ARTIFACTORY_TOKEN</span>
          and your w3id in <span class="sh-mono">IBM_USER</span>;
          <span class="sh-mono">SILICON_HARBOR</span> tells the repository's scripts to leave
          logins and renewal to Silicon Harbor. Silicon Harbor passes a renewed token to
          running environments as soon as it has one.
        </p>
        <p class="sh-muted sh-small">{checkedAgo(artifactory.checkedAt, relativeTime)}</p>

        {#if showForm}
          <div class="sh-form">
            <p>
              Artifactory has no sign-in Silicon Harbor can open for you. Create an identity
              token by hand once: Silicon Harbor uses it to create tokens of its own, which it
              renews while it runs. You can revoke the identity token afterwards.
            </p>
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
                <Button kind="tertiary" size="small" disabled={credentials.renewing} on:click={() => credentials.renewArtifactory()}>
                  {credentials.renewing ? "Renewing…" : "Renew now"}
                </Button>
                <Button kind="danger-ghost" size="small" on:click={() => credentials.removeArtifactory()}>
                  Remove token
                </Button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="sh-buttons">
            <Button kind="tertiary" size="small" disabled={credentials.renewing} on:click={() => credentials.renewArtifactory()}>
              {credentials.renewing ? "Renewing…" : "Renew now"}
            </Button>
            <Button kind="ghost" size="small" on:click={() => (editing = true)}>
              Replace token
            </Button>
            <Button kind="danger-ghost" size="small" on:click={() => credentials.removeArtifactory()}>
              Remove token
            </Button>
          </div>
        {/if}
      </section>
    {/if}

    {#if ibmCloud}
      <section class="sh-cred" aria-labelledby="sh-cred-ibmcloud" data-testid="cred-ibmcloud">
        <header class="sh-cred-head">
          <RequirementIcon state={ibmCloudIcon(ibmCloud)} />
          <h3 id="sh-cred-ibmcloud">
            IBM Cloud <span class="sh-mono sh-muted">{ibmCloud.registry}</span>
          </h3>
          <Tag size="sm" type={tagType(ibmCloud.state)}>
            {ibmCloud.state === "signed-out" ? "Not logged in" : (stateLabel[ibmCloud.state] ?? ibmCloud.state)}
          </Tag>
        </header>

        <p>{ibmCloud.detail}</p>
        <p class="sh-muted sh-small">
          Docker downloads images from {ibmCloud.registry} with this login, through
          docker-credential-icr. The helper keeps the login and renews it; when it no longer
          can, it asks you to log in again in the browser. Silicon Harbor asks it here, so
          that happens now and not in the middle of creating an environment.
        </p>

        {#if ibmCloud.signingIn}
          <div class="sh-signin" data-testid="ibmcloud-sign-in">
            <p>Log in to IBM Cloud in the browser window that opened.</p>
            <InlineLoading description="Waiting for the IBM Cloud login…" />
            <div class="sh-buttons">
              <Button kind="ghost" size="small" on:click={() => credentials.cancelIbmCloudSignIn()}>
                Cancel
              </Button>
            </div>
          </div>
        {:else if ibmCloud.state === "no-helper"}
          <div class="sh-buttons">
            <Button kind="tertiary" size="small" href="#/settings/computer">
              Install on This computer
            </Button>
          </div>
        {:else if ibmCloud.state !== "ok"}
          <div class="sh-buttons">
            <Button kind="primary" size="small" on:click={() => credentials.check()}>
              Log in
            </Button>
          </div>
        {/if}
        <p class="sh-muted sh-small">{checkedAgo(ibmCloud.checkedAt, relativeTime)}</p>
      </section>
    {/if}
  {/if}

  <div class="sh-buttons sh-end">
    <Button
      kind="secondary"
      disabled={credentials.checking ||
        credentials.signingIn ||
        ibmCloud?.signingIn === true}
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

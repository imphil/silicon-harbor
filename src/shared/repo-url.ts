export type RepoUrlCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "ssh" | "invalid" }

/**
 * Validates the Git URL a user pastes into "New environment".
 * Only HTTPS URLs of the form https://host/org/repo[.git] are accepted;
 * SSH URLs are rejected explicitly because Git sign-in is HTTPS-only.
 */
export function checkRepoUrl(input: string): RepoUrlCheck {
  const url = input.trim()
  if (url === "") return { ok: false, reason: "empty" }
  if (/^git@|^ssh:\/\//.test(url)) return { ok: false, reason: "ssh" }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: "invalid" }
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "invalid" }

  const segments = parsed.pathname.split("/").filter((s) => s.length > 0)
  if (segments.length < 2) return { ok: false, reason: "invalid" }

  const name = segments[segments.length - 1].replace(/\.git$/, "")
  if (name === "") return { ok: false, reason: "invalid" }
  return { ok: true, name }
}

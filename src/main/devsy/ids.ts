/**
 * Workspace ids.
 *
 * `devsy workspace up <url> --id <id>` silently reuses an existing workspace
 * with that id (pkg/workspace/workspace.go), so creating a new environment
 * must pick an id that is not taken yet.
 */

const MAX_ID_LENGTH = 48

/** Same normalization as Devsy's workspace.ToID for a plain name. */
export function toWorkspaceId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^\w-]/g, "-")
    .replace(/[^0-9a-z-]+/g, "")
    .slice(0, MAX_ID_LENGTH)
    .replace(/^-+|-+$/g, "")
  return id === "" ? "environment" : id
}

/** `base`, or `base-2`, `base-3`, … whichever is free. */
export function uniqueWorkspaceId(
  name: string,
  taken: Iterable<string>,
): string {
  const used = new Set(taken)
  const base = toWorkspaceId(name)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** Valid ids as accepted over IPC. */
export const WORKSPACE_ID_PATTERN = /^[0-9a-z][0-9a-z-]{0,47}$/

/** "Now" for relative times ("Checked 5 minutes ago"), updated every 30 s. */
class Clock {
  now = $state(Date.now())

  constructor() {
    if (typeof window !== "undefined")
      setInterval(() => {
        this.now = Date.now()
      }, 30_000)
  }
}

export const clock = new Clock()

/** Results older than this are checked again when their page opens. */
export const RECHECK_AFTER_MS = 10 * 60_000

/** "Checked 5 minutes ago", or "" before the first check. */
export function checkedAgo(
  iso: string | undefined,
  relative: (iso: string, now: number) => string,
): string {
  if (!iso) return ""
  return `Checked ${relative(iso, clock.now).toLowerCase()}`
}

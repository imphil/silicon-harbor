/** Toast notifications for action results and failures. */

export interface Toast {
  id: number
  kind: "error" | "success" | "info" | "warning"
  title: string
  subtitle?: string
}

let nextId = 1

class NotificationStore {
  toasts = $state<Toast[]>([])

  push(toast: Omit<Toast, "id">, timeoutMs = 6000): void {
    const id = nextId++
    this.toasts = [...this.toasts, { ...toast, id }]
    if (timeoutMs > 0) setTimeout(() => this.dismiss(id), timeoutMs)
  }

  error(title: string, error: unknown): void {
    this.push({ kind: "error", title, subtitle: errorMessage(error) }, 10000)
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id)
  }
}

/** Electron prefixes IPC errors with "Error invoking remote method '…': Error: ". */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, "")
}

export const notifications = new NotificationStore()

/** Runs an action and reports failures as a toast instead of throwing. */
export async function attempt<T>(
  failureTitle: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await action()
  } catch (error) {
    notifications.error(failureTitle, error)
    return undefined
  }
}

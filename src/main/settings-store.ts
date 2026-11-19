import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { Settings } from "../shared/api"

export const IdeIdSchema = z.enum(["vscode", "bob", "codium"])

const SettingsSchema = z.object({
  defaultIde: IdeIdSchema.catch("bob"),
  autoUpdateCheck: z.boolean().catch(true),
  firstRunDone: z.boolean().catch(false),
})

export const SettingsPatchSchema = z
  .object({
    defaultIde: IdeIdSchema,
    autoUpdateCheck: z.boolean(),
    firstRunDone: z.boolean(),
  })
  .partial()
  .strict()

export const DEFAULT_SETTINGS: Settings = {
  defaultIde: "bob",
  autoUpdateCheck: true,
  firstRunDone: false,
}

/** Settings as a JSON file in Electron's userData directory. */
export class SettingsStore {
  private current: Settings

  constructor(private readonly file: string) {
    this.current = this.load()
  }

  private load(): Settings {
    try {
      const json = JSON.parse(readFileSync(this.file, "utf8")) as unknown
      const parsed = SettingsSchema.safeParse(json)
      if (parsed.success) return parsed.data
    } catch {
      // missing or unreadable: defaults
    }
    return { ...DEFAULT_SETTINGS }
  }

  get(): Settings {
    return { ...this.current }
  }

  update(patch: unknown): Settings {
    const valid = SettingsPatchSchema.parse(patch)
    this.current = { ...this.current, ...valid }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`)
    renameSync(tmp, this.file)
    return this.get()
  }
}

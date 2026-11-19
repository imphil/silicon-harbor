export const settingsSections = [
  { id: "computer", label: "This computer" },
  { id: "ide", label: "IDE" },
  { id: "updates", label: "Updates" },
  { id: "support", label: "Support" },
] as const

export type SettingsSectionId = (typeof settingsSections)[number]["id"]

export function isSettingsSection(value: string): value is SettingsSectionId {
  return settingsSections.some((s) => s.id === value)
}

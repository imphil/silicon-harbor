import type { SiliconHarborApi } from "$shared/api"
import { createMockApi, type MockPlatform, type MockScenario } from "./mock-api"

declare global {
  interface Window {
    siliconHarbor?: SiliconHarborApi
  }
}

const SCENARIOS: MockScenario[] = ["default", "first-run", "empty", "all-ok"]
const PLATFORMS: MockPlatform[] = ["mac", "win", "linux"]

export interface ApiSelection {
  mock: boolean
  scenario?: MockScenario
  platform?: MockPlatform
  speed?: number
}

/**
 * Decides between the preload bridge and the mock.
 *
 * The mock is used when
 * - the build runs in mode "mock" (`npm run dev:mock`) or sets VITE_MOCK_API=1,
 * - the page URL has `?mock=1` (used by the e2e tests), or
 * - there is no preload bridge at all (plain browser, unit tests).
 *
 * `?scenario=default|first-run|empty|all-ok`, `?platform=mac|win|linux` and
 * `?speed=<factor>` tune the mock.
 */
export function selectApi(
  search: string,
  hasBridge: boolean,
  mockEnv: string | undefined,
): ApiSelection {
  const params = new URLSearchParams(search)
  const mock = mockEnv === "1" || params.get("mock") === "1" || !hasBridge
  if (!mock) return { mock: false }

  const scenario = params.get("scenario") as MockScenario | null
  const platform = params.get("platform") as MockPlatform | null
  const speed = Number(params.get("speed"))
  return {
    mock: true,
    scenario: scenario && SCENARIOS.includes(scenario) ? scenario : undefined,
    platform: platform && PLATFORMS.includes(platform) ? platform : undefined,
    speed: Number.isFinite(speed) && speed > 0 ? speed : undefined,
  }
}

let instance: SiliconHarborApi | undefined
let selection: ApiSelection | undefined

/**
 * The API the renderer talks to. This module is the only place that touches
 * `window.siliconHarbor`.
 */
export function api(): SiliconHarborApi {
  if (instance) return instance
  const bridge = window.siliconHarbor
  selection = selectApi(
    window.location.search,
    Boolean(bridge),
    import.meta.env.MODE === "mock" ? "1" : import.meta.env.VITE_MOCK_API,
  )
  instance = selection.mock
    ? createMockApi({
        scenario: selection.scenario,
        platform: selection.platform,
        speed: selection.speed,
        appInfo: bridge ? () => bridge.getAppInfo() : undefined,
      })
    : (bridge as SiliconHarborApi)
  return instance
}

/** True when the UI runs against the mock (shown as a small badge). */
export function usingMock(): boolean {
  api()
  return selection?.mock ?? false
}

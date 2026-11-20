import { linuxDocker, rancherDesktop } from "./container-engine"
import { credentialHelper } from "./credential-helper"
import { gitCredentials } from "./git-credentials"
import { ide } from "./ide"
import type { Requirement } from "./types"
import { wsl } from "./wsl"
import { xquartz } from "./xquartz"

/** The requirements per platform, in display order (PLAN.md §4). */
export function requirementsFor(platform: NodeJS.Platform): Requirement[] {
  switch (platform) {
    case "darwin":
      return [rancherDesktop, xquartz, credentialHelper, gitCredentials, ide]
    case "win32":
      return [wsl, rancherDesktop, credentialHelper, gitCredentials, ide]
    default:
      // Linux (Fedora is the supported distribution).
      return [linuxDocker, credentialHelper, gitCredentials, ide]
  }
}

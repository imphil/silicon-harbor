// electron-builder afterPack hook: ad-hoc signs the macOS app with rcodesign.
//
// Apple silicon refuses to run unsigned code, and electron-builder's own
// signing needs macOS (codesign). rcodesign runs on Linux; without a
// certificate it produces an ad-hoc signature, which is enough to launch the
// app (users still confirm it once in Gatekeeper).
//
// rcodesign is located via $RCODESIGN, then PATH. Missing → the build fails.

const { execFileSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const { join } = require("node:path")

function findRcodesign() {
  const fromEnv = process.env.RCODESIGN
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`RCODESIGN points to ${fromEnv}, which does not exist`)
    }
    return fromEnv
  }
  try {
    execFileSync("rcodesign", ["--version"], { stdio: "ignore" })
    return "rcodesign"
  } catch {
    throw new Error(
      "rcodesign not found. macOS builds need it for ad-hoc signing: " +
        "download apple-codesign from https://github.com/indygreg/apple-platform-rs/releases " +
        "and set RCODESIGN=/path/to/rcodesign (see docs/spikes/packaging.md).",
    )
  }
}

// rcodesign reads RCODESIGN_* variables as configuration and rejects unknown
// keys (e.g. a CI's RCODESIGN_SHA256 → "UnknownField sha256"). Signing needs
// none of them.
function rcodesignEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("RCODESIGN_"),
    ),
  )
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)
  const rcodesign = findRcodesign()

  console.log(`  • ad-hoc signing  ${appPath}`)
  // Signs nested helpers, frameworks and Mach-O files in Resources (devsy).
  execFileSync(rcodesign, ["sign", appPath], {
    stdio: "inherit",
    env: rcodesignEnv(),
  })

  // `rcodesign verify` cannot check ad-hoc signatures (it expects a CMS blob
  // and fails with "CMS error"), so assert the signature info instead.
  const productFilename = context.packager.appInfo.productFilename
  for (const binary of [
    join(appPath, "Contents", "MacOS", productFilename),
    join(appPath, "Contents", "Resources", "bin", "devsy"),
  ]) {
    const info = execFileSync(rcodesign, ["print-signature-info", binary], {
      encoding: "utf8",
      env: rcodesignEnv(),
    })
    if (!/flags: CodeSignatureFlags\(ADHOC/.test(info)) {
      throw new Error(`no ad-hoc signature on ${binary}:\n${info}`)
    }
    console.log(`  • ad-hoc signature ok  ${binary}`)
  }
}

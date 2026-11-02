// Runs after electron-builder assembles the app, before the .dmg/.zip is made.
// Without a paid Apple Developer ID, macOS on Apple Silicon refuses to open an app whose signature
// was invalidated by packaging ("BidMail is damaged"). An ad-hoc signature fixes that; users then
// open the app the first time with right-click > Open.
// The signature's "designated requirement" is set to BidMail's bundle id. By default an ad-hoc signature requires
// its own exact hash, so macOS's updater (Squirrel) would reject every new version as "not the same app";
// with this requirement, any build with BidMail's id passes and automatic updates work.
// When a real certificate is configured (CSC_LINK / CSC_NAME), electron-builder signs instead.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const id = context.packager.appInfo.id
  console.log('  • ad-hoc signing', app)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // The app itself last, with the requirement (--deep above signed everything inside it first).
  execFileSync('codesign', ['--force', '--sign', '-', '-r=designated => identifier "' + id + '"', app], { stdio: 'inherit' })
}

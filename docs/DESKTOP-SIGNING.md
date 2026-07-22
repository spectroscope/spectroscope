# Signing & notarizing the desktop app (Apple Developer ID)

The release `.dmg` from `scripts/build-desktop-runkit.sh` is **ad-hoc signed**:
it opens, but on first download macOS says *"unidentified developer"* and the
user has to right-click → Open once. That is free and needs no Apple account.

For a **double-click, zero-warning** app you need a paid **Apple Developer
Program** membership, a **Developer ID Application** certificate, and
**notarization**. This guide builds that end to end.

> One-line summary: enroll → make a "Developer ID Application" cert → sign the
> app *and the bundled JRE* with hardened runtime + entitlements → notarize →
> staple. The only spectroscope-specific twist is the bundled JRE (step 4).

---

## 0. What you need

- **Apple Developer Program** membership — **$99/year**
  (developer.apple.com/programs). Individual (your name) or Organization
  (needs a D-U-N-S number, shows the company name as the developer).
- A Mac with **Xcode command-line tools** (`xcode-select --install`).
- The team's **Team ID** (a 10-char code, e.g. `AB12CD34EF`) — shown in the
  Apple Developer portal under Membership.

## 1. Enroll

developer.apple.com → Account → Enroll. Pay the $99. Approval is minutes
(Individual) to a few days (Organization, D-U-N-S verification).

## 2. Create the "Developer ID Application" certificate

This is the cert that signs apps distributed **outside** the App Store.

**Easiest — via Xcode:**
Xcode → Settings → Accounts → sign in with your Apple ID → select the team →
*Manage Certificates…* → **＋** → **Developer ID Application**. It lands in your
login keychain.

**Or manually (portal + CSR):**
1. Keychain Access → Certificate Assistant → *Request a Certificate From a
   Certificate Authority* → save a `CertificateSigningRequest.certSigningRequest`
   to disk (choose "Saved to disk").
2. developer.apple.com → Certificates → **＋** → **Developer ID Application** →
   upload the CSR → download the `.cer` → double-click it to install into the
   **login** keychain.

**Verify it's there:**
```bash
security find-identity -v -p codesigning
#   1) ABC123…  "Developer ID Application: Your Name (TEAMID)"
```
Keep that exact string; it is your signing identity.

## 3. Store notarization credentials

Notarization uploads the build to Apple. Authenticate with an **app-specific
password** (simplest) or an App Store Connect API key.

1. appleid.apple.com → Sign-In and Security → **App-Specific Passwords** →
   generate one (label it `notarytool`). Copy the `xxxx-xxxx-xxxx-xxxx` value.
2. Save it into the keychain so tools can reuse it:
```bash
xcrun notarytool store-credentials "spectro-notary" \
  --apple-id "you@example.com" \
  --team-id  "TEAMID" \
  --password "xxxx-xxxx-xxxx-xxxx"     # the app-specific password
```
Now `--keychain-profile "spectro-notary"` works without secrets on the command line.

## 4. Entitlements (the bundled-JRE twist)

Under **hardened runtime** (required for notarization) macOS blocks the JVM's
JIT and the loading of dylibs not signed by your team. The bundled JRE trips
both. Create `spectro-desktop/build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

- `allow-jit` + `allow-unsigned-executable-memory` — the JVM JIT-compiles.
- `disable-library-validation` — lets the app process load the JRE's dylibs
  (they're signed by *you*, not Apple, once you re-sign them below).

## 5. Sign — the app **and** the JRE

electron-builder signs the app bundle + Electron framework, but **not** the
`extraResources` JRE. Every Mach-O must be signed with your Developer ID +
hardened runtime, or notarization rejects the build. Sign the JRE inside-out
first, then let electron-builder seal the app.

`package.json` → `build.mac`:
```json
"mac": {
  "icon": "icon.icns",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist"
}
```

Sign the JRE before packaging (an electron-builder `afterPack` hook, or inline
in the build script right after `jlink`):
```bash
ID="Developer ID Application: Your Name (TEAMID)"
ENT="spectro-desktop/build/entitlements.mac.plist"
# sign every Mach-O in the runtime, deepest first
find spectro-desktop/jre -type f \( -name '*.dylib' -o -perm +111 \) -print0 \
  | xargs -0 -I{} codesign --force --timestamp --options runtime \
      --entitlements "$ENT" --sign "$ID" "{}"
```
Then build with the identity available (electron-builder auto-discovers it):
```bash
# do NOT set CSC_IDENTITY_AUTO_DISCOVERY=false, and do NOT use `--sign -`
( cd spectro-desktop && npm run build && npx electron-builder --dir )
codesign --force --deep --options runtime --timestamp \
  --entitlements "$ENT" --sign "$ID" spectro-desktop/release/mac-*/spectroscope.app
codesign --verify --deep --strict spectro-desktop/release/mac-*/spectroscope.app
```

## 6. Package, notarize, staple

```bash
V=0.1.1; ARCH=arm64
APP=spectro-desktop/release/mac-${ARCH}/spectroscope.app
DMG=spectro-desktop/release/spectroscope-${V}-${ARCH}.dmg

# dmg from the signed app (as build-desktop-runkit.sh already does)
STAGE=$(mktemp -d); ditto "$APP" "$STAGE/spectroscope.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname spectroscope -srcfolder "$STAGE" -ov -format UDZO "$DMG"; rm -rf "$STAGE"

# notarize the dmg, then staple the ticket into it
xcrun notarytool submit "$DMG" --keychain-profile "spectro-notary" --wait
xcrun stapler staple "$DMG"
```

`notarytool … --wait` blocks until Apple returns `Accepted` (usually 1–5 min).
If it says `Invalid`, run `xcrun notarytool log <submission-id> --keychain-profile spectro-notary`
— it lists the exact unsigned/unentitled binary.

## 7. Verify (what the user's Mac will see)

```bash
spctl -a -t open --context context:primary-signature -v "$DMG"   # → accepted, source=Notarized Developer ID
xcrun stapler validate "$DMG"                                      # → The validate action worked!
codesign -dv --verbose=2 "$APP" | grep -E 'Authority|TeamIdentifier'
```
A stapled, notarized dmg opens on **double-click** with no warning, even offline.

## 8. Wire it into the release

In `scripts/build-desktop-runkit.sh`, gate on whether a Developer ID is present:
sign + notarize when it is, fall back to the current ad-hoc `--sign -` when it
isn't (so the script keeps working on machines without the cert). Keep the
credentials in the keychain / env, **never** in the repo.

## Gotchas

- **The JRE is the whole difficulty.** A single unsigned `.dylib` or launcher
  inside `spectro-desktop/jre` fails notarization. Sign the runtime inside-out
  (step 5) before sealing the app.
- **Never commit certificates, private keys, or the app-specific password.**
- **Universal / Intel:** this signs the host arch. For an Intel or universal
  build, build and sign on/for that arch too, then notarize each dmg.
- **Windows/Linux** have their own signing stories (Authenticode / none) — out
  of scope here.
- **Do not use the Valtech corporate certificate** that may appear in
  `security find-identity` — spectroscope ships under its own identity only.

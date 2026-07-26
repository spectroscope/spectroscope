# Signing & notarizing the desktop app (Apple Developer ID)

Without a Developer ID in the keychain, the `.dmg` from
`scripts/build-desktop-runkit.sh` is **ad-hoc signed**: it opens, but on first
download macOS says *"unidentified developer"* and the user has to
right-click → Open once. That is free and needs no Apple account. With a
Developer ID (and a notary profile) the same script signs, notarizes and
staples on its own; step 8 describes the auto-selection.

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

## 5. Sign — the app **and** every bundled binary set

electron-builder signs the app bundle + Electron framework, but **not** the
`extraResources` — and the run kit carries two binary sets there: the jlink'd
JRE (`spectro-desktop/jre`) and llama.cpp's `llama-server` with its dylib
closure (`spectro-desktop/bin`, see step 5b). Every Mach-O in both must be
signed with your Developer ID + hardened runtime, or notarization rejects the
build. Sign them inside-out first — dylibs, then executables — then let
electron-builder seal the app.

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

Sign the bundled binaries before packaging (an electron-builder `afterPack`
hook, or inline in the build script right after `jlink` and the llama fetch):
```bash
ID="Developer ID Application: Your Name (TEAMID)"
ENT="spectro-desktop/build/entitlements.mac.plist"
# dylibs first, then executables, so nothing is sealed over an unsigned dependency
find spectro-desktop/jre spectro-desktop/bin -type f -name '*.dylib' -print0 \
  | xargs -0 -I{} codesign --force --timestamp --options runtime \
      --entitlements "$ENT" --sign "$ID" "{}"
find spectro-desktop/jre spectro-desktop/bin -type f ! -name '*.dylib' -perm +111 -print0 \
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

## 5b. The bundled `llama-server` (the second binary set)

The run kit ships llama.cpp's `llama-server` so the built-in model works on a
machine with nothing else installed. `scripts/fetch-llama-server.sh` stages it
into `spectro-desktop/bin`; the run-kit script calls it as step 2b and signs
the result together with the JRE. What matters for signing:

- **It is the official llama.cpp release build, not Homebrew's.** brew's
  binary wires `libggml`, `libggml-base` and OpenSSL to absolute
  `/opt/homebrew` paths, which exist on no user's machine — bundling it would
  mean rewriting every load path with `install_name_tool`. The official macOS
  build references each library as `@rpath/...` with an `LC_RPATH` of
  `@loader_path`, links no OpenSSL at all, and compiles the Metal shaders into
  `libggml-metal`. Nothing to rewrite: copy and sign.
- **Pinned twice.** Build tag and tarball sha256. An unpinned fetch would put
  unreviewed code into an artifact notarized under our Developer ID.
- **The dylib closure must close.** The fetch script walks `llama-server`'s
  transitive `@rpath` graph (11 Mach-O files, ~22 MB — not the ~30 extra tools
  the release also ships) and **fails the build** if any load path points
  outside the bundle. A single absolute reference means the app runs on the
  build machine and dies everywhere else.
- **Self-containment was measured.** Under `DYLD_PRINT_LIBRARIES` a real
  inference run loads all 11 Mach-O files from the bundle and zero from
  `/opt/homebrew`, which also covers the dlopen'd ggml backends that
  `otool -L` cannot see.
- **No extra entitlement.** The worry was that the hardened runtime would
  block the ggml Metal backend. Measured on a real run: the signed binary
  still serves inference at 66 tok/s, so Metal survives with the JRE's
  entitlement set from step 4. Do not add entitlements preemptively; if a
  future backend needs one, name it here with the reason.

## 6. Package, notarize, staple

```bash
V=0.1.1; ARCH=arm64
APP=spectro-desktop/release/mac-${ARCH}/spectroscope.app
DMG=spectro-desktop/release/spectroscope-${V}-${ARCH}.dmg

# dmg from the signed app (as build-desktop-runkit.sh already does)
STAGE=$(mktemp -d); ditto "$APP" "$STAGE/spectroscope.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname spectroscope -srcfolder "$STAGE" -ov -format UDZO "$DMG"; rm -rf "$STAGE"

# sign the dmg ITSELF — notarization accepts an unsigned dmg, but the spctl
# verify line in step 7 rejects it with "no usable signature" (0.2.0 and 0.3.0
# shipped that way; the app inside was still fully notarized)
codesign --force --timestamp --sign "$ID" "$DMG"

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

## 8. Wire it into the release — DONE

`scripts/build-desktop-runkit.sh` already does all of the above, auto-selected:

- **Identity** — it uses `SIGN_IDENTITY` if set, else auto-detects a "Developer
  ID Application" cert from the keychain (and **refuses the Valtech one**). No
  cert → it falls back to the ad-hoc `--sign -` path unchanged, so the script
  still works on machines without a Developer ID.
- **JRE + llama-server** — with an identity it signs every Mach-O in
  `spectro-desktop/jre` *and* `spectro-desktop/bin` inside-out (step 2c:
  dylibs first, then executables) with the hardened runtime +
  `build/entitlements.mac.plist` **before** electron-builder seals the app,
  then reseals + hard-verifies.
- **Notarize** — it signs the `.dmg` itself, then — if a notarytool profile
  exists (`NOTARY_PROFILE`, default `spectro-notary`) — submits, waits,
  staples, and validates it. No profile → it signs but skips notarization and
  says so.

`package.json` → `build.mac` carries `hardenedRuntime` + the entitlements, so
electron-builder signs the Electron framework and helper apps correctly.

Run the signed build:
```bash
# one-time: store the notarization profile (step 3), then just:
scripts/build-desktop-runkit.sh
# or pin the identity / profile explicitly:
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  NOTARY_PROFILE="spectro-notary" scripts/build-desktop-runkit.sh
```

Keep the credentials in the keychain / env, **never** in the repo.

## Gotchas

- **The bundled binaries are the whole difficulty.** A single unsigned
  `.dylib` or launcher inside `spectro-desktop/jre` or `spectro-desktop/bin`
  fails notarization. Sign both sets inside-out (step 5) before sealing the
  app.
- **Never commit certificates, private keys, or the app-specific password.**
- **Universal / Intel:** this signs the host arch. For an Intel or universal
  build, build and sign on/for that arch too, then notarize each dmg.
- **Windows/Linux** have their own signing stories (Authenticode / none) — out
  of scope here.
- **Do not use the Valtech corporate certificate** that may appear in
  `security find-identity` — spectroscope ships under its own identity only.

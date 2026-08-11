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
> app *and both bundled binary sets* (the jlink'd JRE, llama.cpp's
> `llama-server`) with hardened runtime + entitlements → sign the `.dmg`
> **itself** → notarize → staple → verify the container *and* the app inside it.

The spectroscope-specific parts are the two bundled binary sets (steps 5 and
5b), the container signature (step 6), and the two-artifact verify (step 7).
Everything else is stock Apple distribution.

**The identity for this repo is fixed:**
`Developer ID Application: Christopher Ezell (N7KX5K4T3Q)`. Sections 1 to 3 are
the generic enrollment path, kept for whoever has to redo it. Never sign with
the Valtech corporate certificate, which has appeared in this machine's keychain
before; `build-desktop-runkit.sh` filters it out unconditionally and exits if
`SIGN_IDENTITY` names it.

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

### This certificate dies on 2027-02-01, and renewing early will not help

Read the dates, not just the name:

```bash
security find-certificate -c "Developer ID Application: Christopher Ezell (N7KX5K4T3Q)" -p \
  | openssl x509 -noout -dates
#   notBefore=Jul 22 11:27:43 2026 GMT
#   notAfter=Feb  1 22:12:15 2027 GMT
```

That is 194 days of life on a certificate that normally carries a multi-year
term. The short life is not an enrollment problem and not a mistake in the CSR.
The issuing intermediate expires at the same instant:

```bash
security find-certificate -c "Developer ID Certification Authority" -p \
  /System/Library/Keychains/SystemRootCertificates.keychain \
  | openssl x509 -noout -subject -dates -serial
#   subject=CN=Developer ID Certification Authority, O=Apple Inc., C=US
#   notBefore=Feb  1 22:12:15 2012 GMT
#   notAfter=Feb  1 22:12:15 2027 GMT
#   serial=187AA9A8C296210C
```

Same second, `22:12:15`. A CA cannot issue a leaf that outlives itself, so every
leaf under this intermediate is clamped to 2027-02-01, and reissuing the leaf
today just produces another clamped one. The chain is provable rather than
assumed: the leaf's Authority Key Identifier equals that intermediate's Subject
Key Identifier (`57:17:ED:A2:CF:DC:7C:98:A1:10:E0:FC:BE:87:2D:2C:F2:E3:17:54`,
readable with `openssl x509 -noout -ext authorityKeyIdentifier`). The root is
not the constraint; Apple Root CA runs to 2035-02-09. Apple's successor
intermediate carries the suffix `- G2` in its common name, and it is not in this
machine's keychain today, so a renewal near the deadline will move the build
onto a chain nobody here has signed against yet. Budget a test build for that,
not just a certificate download.

**What breaks on that date is new signing, not shipped releases.** Every
`codesign` call in `scripts/build-desktop-runkit.sh` passes `--timestamp`
(lines 97, 100, 137, 156), so each signature carries an Apple timestamp proving
it was made while the certificate was valid, and the notarization ticket is
stapled into the dmg. Both effects outlive the certificate. Confirm it on any
artifact already out the door:

```bash
codesign -dvv --verbose=4 spectro-desktop/release/spectroscope-0.5.0-arm64.dmg 2>&1 \
  | grep -E "Authority|Timestamp"
#   Authority=Developer ID Application: Christopher Ezell (N7KX5K4T3Q)
#   Authority=Developer ID Certification Authority
#   Authority=Apple Root CA
#   Timestamp=31. Jul 2026 at 17:53:08
```

A `Timestamp=` line means that build keeps validating on user machines after
2027-02-01. A build signed without `--timestamp` would start failing Gatekeeper
the moment the certificate expires, which is the reason that flag is not
optional here. If a cut is planned for early 2027, renew before the cut and
verify the new chain end to end, because after 2027-02-01 there is no signing
identity at all until the replacement is installed.

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
both.

**This file is not in the repo, and nothing has to copy it in.** `.gitignore`
ignores `build/`, so `spectro-desktop/build/entitlements.mac.plist` is untracked
and no clone and no fresh worktree carries it — which is why
`scripts/build-desktop-runkit.sh` **writes** it in its step 0, on every run, from
exactly the text below. Until then the script only checked for the file and
exited, so a signed build ran in one directory on one machine: the one that had
signed before. That is what stopped the 0.6.1 cut (card 174).

The block below and the heredoc in that script are the same bytes in two places.
**Change both, or this section becomes folklore.** Measured 2026-08-10: the
heredoc's output is byte-identical (md5 `62bedbe76096b50428f2b281e47001e5`) to the
file this machine had been signing with since 2026-07-22, and `codesign -d
--entitlements -` reads all three keys back off a binary signed with it.

That is now checked rather than remembered: `scripts/test-release-scripts.sh`
runs step 0 in a `mktemp` directory that has never been built in, extracts the
block below out of this file, and diffs the two. Re-measured 2026-08-11 — same
md5, identical, and `codesign --options runtime --entitlements` accepts the
written file and reads all three keys back.

The content, which is also what the script writes:

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
Then build with the identity **pinned**, not auto-discovered:
```bash
# do NOT set CSC_IDENTITY_AUTO_DISCOVERY=false, and do NOT use `--sign -`.
# CSC_NAME wants the common name WITHOUT the "Developer ID Application: "
# prefix; codesign below wants the full string. Passing the full string to
# CSC_NAME makes electron-builder find no cert.
( cd spectro-desktop && npm run build \
  && CSC_NAME="${ID#Developer ID Application: }" npx electron-builder --dir )
codesign --force --deep --options runtime --timestamp \
  --entitlements "$ENT" --sign "$ID" spectro-desktop/release/mac-*/spectroscope.app
codesign --verify --deep --strict spectro-desktop/release/mac-*/spectroscope.app
```

Pin it rather than letting electron-builder pick: auto-discovery takes whatever
"Developer ID Application" cert it finds first, and on a machine that also
carries the Valtech certificate that is the wrong answer with no error.

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
  transitive `@rpath` graph (11 Mach-O files, 22.5 MiB measured in the shipped
  0.4.1 bundle, not the ~30 extra tools the release also ships) and **fails the
  build** if any load path points outside the bundle. A single absolute
  reference means the app runs on the build machine and dies everywhere else.
- **Same treatment as the JRE, no exception.** Inside-out signing (dylibs, then
  executables), Developer ID, hardened runtime, same entitlements file. Step 2c
  of the build script passes `spectro-desktop/bin` and `spectro-desktop/jre` to
  the same two `find | codesign` passes. Section 7 has the loop that audits the
  result in a finished dmg.
- **Self-containment was measured.** Under `DYLD_PRINT_LIBRARIES` a real
  inference run loads all 11 Mach-O files from the bundle and zero from
  `/opt/homebrew`, which also covers the dlopen'd ggml backends that
  `otool -L` cannot see.
- **No extra entitlement.** The worry was that the hardened runtime would
  block the ggml Metal backend. Measured on a real run: the signed binary
  still serves inference at 66 tok/s, so Metal survives with the JRE's
  entitlement set from step 4. Do not add entitlements preemptively; if a
  future backend needs one, name it here with the reason.

## 6. Package, sign the container, notarize, staple

The version is not a constant to type: the script reads it from
`spectro-server/build.gradle.kts`. Do the same or pass `VERSION=`.

```bash
V=$(sed -nE 's/^version = "([^"]+)".*/\1/p' spectro-server/build.gradle.kts | head -1)
ARCH=arm64
APP=spectro-desktop/release/mac-${ARCH}/spectroscope.app
DMG=spectro-desktop/release/spectroscope-${V}-${ARCH}.dmg

# dmg from the signed app (as build-desktop-runkit.sh already does)
STAGE=$(mktemp -d); ditto "$APP" "$STAGE/spectroscope.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname spectroscope -srcfolder "$STAGE" -ov -format UDZO "$DMG"; rm -rf "$STAGE"

# sign the CONTAINER itself. See below for why this line has to exist.
codesign --force --timestamp --sign "$ID" "$DMG"
codesign --verify "$DMG"

# notarize the dmg, then staple the ticket into it
xcrun notarytool submit "$DMG" --keychain-profile "spectro-notary" --wait
xcrun stapler staple "$DMG"
```

`notarytool … --wait` blocks until Apple returns `Accepted` (usually 1 to 5
min). If it says `Invalid`, run
`xcrun notarytool log <submission-id> --keychain-profile spectro-notary`. It
names the exact unsigned or unentitled binary.

### Why the container needs its own signature

Signing the app is not signing the dmg. They are two artifacts with two
signatures, and Apple's tooling will not tell you the second one is missing:

- **Notarization accepts an unsigned dmg.** The submission succeeds, Apple
  returns `Accepted`, and `xcrun stapler staple` attaches the ticket.
- **`stapler validate` then passes on that unsigned container.** Measured
  2026-07-27 against the shipped `spectroscope-0.2.0-arm64.dmg`: `codesign -dv`
  finds no signature at all, `spctl` answers `source=no usable signature`, and
  `xcrun stapler validate` still answers *"The validate action worked!"*. A
  ticket can sit on a container that carries no signature.

That combination is why the defect survived two notarized releases. **0.2.0 and
0.3.0 both shipped an unsigned container**, with a correctly signed and notarized
app inside. The `codesign … "$DMG"` line landed in `87d5207`, after `v0.3.0` and
before `v0.4.0`, so **0.4.0 is the first release whose container carries a
signature**. Nothing in the build had failed loudly; the script's own success
message was the stapler, which is the weaker check.

(0.1.0 is a separate case, not this bug. It predates Developer ID signing
entirely, since `b9d3168` landed after the `v0.1.0` commit, so both its app and
its container were ad-hoc and it was never notarized. Measured: `code object is
not signed at all`, no ticket.)

**Do not use `stapler validate` as the release gate.** It proves a ticket is
attached, nothing more. Only `spctl` or `codesign -dv` proves the container is
signed.

## 7. Verify — both artifacts, after the staple

One file ships two signed things: the `.dmg` container and the
`spectroscope.app` inside it. Check both, and check the app **inside the
container**, not the copy left behind in `release/mac-<arch>/`.

```bash
# 1. the container
spctl -a -t open --context context:primary-signature -v "$DMG"
#   → accepted   source=Notarized Developer ID
xcrun stapler validate "$DMG"
#   → The validate action worked!

# 2. the app INSIDE the container
MP=$(mktemp -d)
hdiutil attach -readonly -nobrowse -mountpoint "$MP" "$DMG"
spctl -a -vv "$MP/spectroscope.app"
#   → accepted   source=Notarized Developer ID
#     origin=Developer ID Application: Christopher Ezell (N7KX5K4T3Q)
hdiutil detach "$MP"
```

The verify command differs per artifact and the two are not interchangeable:
`spctl -a -t open --context context:primary-signature -v` for the dmg,
`spctl -a -vv` for the app.

**Mount rather than assume.** The shipped app is a `ditto` copy repacked by
`hdiutil`; it is a different file from the one you signed, so it is worth one
command to confirm they are the same code. Compare the seals:

```bash
codesign -d --verbose=4 spectro-desktop/release/mac-arm64/spectroscope.app 2>&1 | grep '^CDHash'
codesign -d --verbose=4 "$MP/spectroscope.app" 2>&1 | grep '^CDHash'
```

Measured 2026-07-27 on `spectroscope-0.4.1-arm64.dmg`: identical,
`CDHash=57fa71715e31086ce0eb309fd4580dc1cda92d56`. `hdiutil` preserved the
signature exactly, as expected. Confirm it, do not take it on trust.

**`stapler validate` on the inner app is supposed to fail.** It reports
*"spectroscope.app does not have a ticket stapled to it"*, because the ticket
lives on the container. Validate the ticket against the dmg; judge the app with
`spctl`.

### The three readings

Measured 2026-07-27, same command
(`spctl -a -t open --context context:primary-signature -v`) against a dmg in
each state:

| container state | verdict |
|---|---|
| unsigned (shipped 0.2.0 and 0.3.0, and every ad-hoc build) | `rejected` · `source=no usable signature` |
| signed, notarization not yet stapled | `rejected` · `source=Unnotarized Developer ID` |
| signed + notarized + stapled (0.4.0 onward) | `accepted` · `source=Notarized Developer ID` |

An **ad-hoc build reads `no usable signature` by design**: the script only signs
the dmg when a Developer ID is present. That is not a regression to fix.

**Which local file reproduces which row.** Row 1 reproduces on
`spectro-desktop/release/spectroscope-0.2.0-arm64.dmg`. It does **not** reproduce
on the `0.3.0`-named dmg in that directory, which reads `accepted` — that file is
a rebuild from the card-100 fix session, not the artifact that shipped
(`codesign -dvv` puts its signature at 2026-07-26 23:32, two days after `v0.3.0`
and four minutes before `87d5207` was committed). The claim about the shipped
0.3.0 rests on the commit order, not on that file: `git merge-base --is-ancestor
87d5207 v0.3.0` fails and `… v0.4.0` succeeds, so the release build of 0.3.0 had
no line that could sign the container. Do not "correct" this table from a local
rebuild.

### Timing trap: never read spctl while notarization is in flight

A check run before `xcrun stapler staple` reports `Unnotarized Developer ID` for
a build that is signed correctly and will read `accepted` a few minutes later.
The ticket is what changes the verdict, and until it is stapled the artifact
looks unnotarized. A reviewer of the 0.4.0 build hit exactly this and filed the
release as unnotarized; the build was fine.

Re-measure after the staple step prints "The validate action worked!". Treat a
single negative reading as a question about ordering before treating it as an
answer about the build.

### Auditing every bundled Mach-O in a shipped dmg

The failure mode this catches is one binary in `jre/` or `bin/` that got sealed
without the Developer ID. Notarization would have rejected it, but if you are
holding a dmg and want to know rather than infer:

```bash
MP=$(mktemp -d); hdiutil attach -readonly -nobrowse -mountpoint "$MP" "$DMG"
R="$MP/spectroscope.app/Contents/Resources"
find "$R/bin" "$R/jre" -type f ! -type l | while read -r f; do
  file "$f" | grep -q 'Mach-O' || continue
  codesign -dv "$f" 2>&1 | grep -q 'TeamIdentifier=N7KX5K4T3Q' || echo "NOT OURS: $f"
done
hdiutil detach "$MP"
```

Measured 2026-07-27 on `spectroscope-0.4.1-arm64.dmg`: no output, and `bin/`
holds 11 Mach-O files at 22.5 MiB (the `! -type l` above matters — counting the
symlinked `.0.dylib` aliases too gives 20).

`-dv` prints `TeamIdentifier`, which is what the loop greps, but it does **not**
print the `Authority` chain. For that reading add a second `v`:

```bash
codesign -dvv "$R/bin/llama-server" 2>&1 | grep -E 'flags|Authority=Developer'
#   CodeDirectory v=20500 … flags=0x10000(runtime) …
#   Authority=Developer ID Application: Christopher Ezell (N7KX5K4T3Q)
```

Both `bin/llama-server` and `jre/bin/java` read that way.

A stapled, notarized, **signed** dmg opens on double-click with no warning, even
offline.

## 8. Wire it into the release — DONE

`scripts/build-desktop-runkit.sh` already does all of the above, auto-selected:

- **Entitlements** — step 0 writes `build/entitlements.mac.plist` from step 4's
  content and lints it before anything else runs, so a checkout made a minute ago
  signs exactly like the release machine.
- **Identity** — it uses `SIGN_IDENTITY` if set, else auto-detects a "Developer
  ID Application" cert from the keychain (and **refuses the Valtech one**). No
  cert → it falls back to the ad-hoc `--sign -` path unchanged, so the script
  still works on machines without a Developer ID.
- **JRE + llama-server** — with an identity it signs every Mach-O in
  `spectro-desktop/jre` *and* `spectro-desktop/bin` inside-out (step 2c:
  dylibs first, then executables) with the hardened runtime +
  `build/entitlements.mac.plist` **before** electron-builder seals the app,
  then reseals + hard-verifies.
- **Container** — step 6 signs the `.dmg` itself right after `hdiutil create`
  and hard-verifies it (`codesign --verify`), so a failed container signature
  stops the build. On the ad-hoc path the dmg stays unsigned on purpose.
- **Notarize** — step 7 probes for a notarytool profile with
  `xcrun notarytool history` (`NOTARY_PROFILE`, default `spectro-notary`). Found:
  submit, wait, staple, `stapler validate`. Not found: it signs, skips
  notarization, and says so.

`package.json` → `build.mac` carries `hardenedRuntime` + the entitlements, so
electron-builder signs the Electron framework and helper apps correctly. The
script's own step 4 (`[4/7]`, the `electron-builder --dir` call) pins the cert
via `CSC_NAME` (prefix stripped) instead of relying on auto-discovery. The step
numbers in these four bullets are the build script's, not this document's.

**What the script does not do:** it never runs `spctl`, and it never inspects the
app *inside* the finished dmg. Its last word is `stapler validate`, which passes
on an unsigned container (step 6). Section 7 is therefore a manual ritual on
every release build, not something the script has already covered for you.

Run the signed build:
```bash
# one-time: store the notarization profile (step 3), then just:
scripts/build-desktop-runkit.sh
# or pin the identity / profile explicitly:
SIGN_IDENTITY="Developer ID Application: Christopher Ezell (N7KX5K4T3Q)" \
  NOTARY_PROFILE="spectro-notary" scripts/build-desktop-runkit.sh
```

Then run section 7 by hand against the dmg it produced.

Keep the credentials in the keychain / env, **never** in the repo.

## Gotchas

- **The bundled binaries are the whole difficulty.** A single unsigned
  `.dylib` or launcher inside `spectro-desktop/jre` or `spectro-desktop/bin`
  fails notarization. Sign both sets inside-out (step 5) before sealing the
  app.
- **The container is a separate artifact from the app.** Sign it, and verify it
  separately (steps 6 and 7). Three releases shipped without a container
  signature because nothing in the toolchain complains.
- **`xcrun stapler validate` is not a signature check.** It passes on an
  unsigned dmg. Use `spctl` or `codesign -dv` to judge the signature.
- **A negative `spctl` reading during notarization is meaningless.** Read it
  after the staple, never before.
- **`build/entitlements.mac.plist` is untracked** (`.gitignore` ignores
  `build/`), so `build-desktop-runkit.sh` step 0 writes it from step 4's content
  on every run. Nothing recreates it by hand any more — the version of this
  script that only checked for the file is what stopped the 0.6.1 release in a
  fresh worktree (card 174).
- **`CSC_NAME` takes the common name without the `Developer ID Application: `
  prefix**; `codesign --sign` takes the full string. Mixing them up makes
  electron-builder report no certificate found.
- **The signing certificate expires 2027-02-01 and cannot be extended past it.**
  The issuing intermediate expires the same second, so every reissue is clamped
  to the same date. New signing stops; already-shipped dmgs keep validating
  because they are timestamped and stapled. See the subsection in step 2.
- **Never commit certificates, private keys, or the app-specific password.**
- **Universal / Intel:** this signs the host arch. For an Intel or universal
  build, build and sign on/for that arch too, then notarize each dmg. Note that
  `fetch-llama-server.sh` pins the arm64 tarball's sha256 and exits on x86_64
  until `LLAMA_SHA256` is set for the x64 asset.
- **Windows/Linux** have their own signing stories (Authenticode, none). Out of
  scope here.
- **Do not use the Valtech corporate certificate** if it appears in
  `security find-identity`. spectroscope ships under its own identity only, and
  the build script exits rather than use it.

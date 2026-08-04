# Release playbook — spectroscope

The end-to-end runbook for cutting a release: the two libraries to **Maven
Central**, one downloadable asset per app/frontend module to the **GitHub
release** (including the self-contained **desktop run kit**), and the website /
portal / docs install snippets flipped to the real coordinates.

This is the *whole* ritual. [`RELEASING.md`](../RELEASING.md) is the narrower
"just Maven Central" reference; it and this file agree.

> **Maven Central is append-only.** There is no unpublishing, only new versions.
> Publish *only* after a full green gate, and the next release is always a bump
> (0.1.0 → 0.1.1 → …), never a re-publish of an existing version.
>
> **Version counter — bump this line with every cut.** Published so far:
> **0.1.0, 0.2.0, 0.3.0, 0.4.0, 0.4.1** (2026-07-27), **0.5.0** (2026-07-31),
> **0.6.0** and **0.6.1** (both 2026-08-04). Those numbers are burned forever;
> the next release MUST be **0.6.2 or higher**. Pick the number by what is in
> the cut, not by habit: 0.5.0 carries features (node triggers, the PTY shell,
> reasoning capabilities), so a patch number would have undersold it and readers
> skip patches — while 0.6.1 is a patch by the same rule, because its headline is
> a desktop shell that forgot every preference on every start. This applies to
> every artifact in the table below, not just the Maven libs: apps and the
> desktop kit move to the same number in step 2.

---

## What a release contains

| Artifact | Where | How |
|---|---|---|
| `dev.spectroscope:spectro-core` | Maven Central | `publishAndReleaseToMavenCentral` |
| `dev.spectroscope:spectro-orchestrator` | Maven Central | same (POM pins core at the same version) |
| `spectro-<v>.zip` (CLI) | GitHub release asset | `scripts/build-release-assets.sh` |
| `spectro-server-<v>.jar` | GitHub release asset | ″ |
| `spectro-mcp-notes-<v>.zip` | GitHub release asset | ″ |
| `spectroscope-<v>-<arch>.dmg` (macOS desktop run kit) | GitHub release asset | `scripts/build-desktop-runkit.sh` |
| `spectroscope-<v>-x86_64.AppImage` (Linux run kit) | GitHub release asset | `linux-kit.yml`, step 8c |
| `spectroscope_<v>_amd64.deb` (Linux run kit) | GitHub release asset | ″ |

Rule of thumb: **every module ships something a user can actually run.** The
libraries go to Maven; the CLI, the server, mcp-notes and the two desktop kits
go to the GitHub release. Two deliberate exceptions: `spectro-web` shipped a
built-UI zip once, at 0.1.0, and it was pulled the same day (owner: a single
page application without its server is dead as a file) - the UI ships inside
the server jar and the desktop kits instead; and `spectro-desktop` is an npm
module that can never go to Maven Central.

Beyond the release itself, three surfaces carry the same artifacts onward and
are bumped in steps 8b to 9: the Homebrew cask (macOS), the apt repository
(Debian/Ubuntu), and the install snippets on both websites.

## Prerequisites (one-time, owner)

- Central Portal token + GPG signing key in `~/.gradle/gradle.properties`
  (`mavenCentralUsername/Password`, `signingInMemoryKey/Password`). Namespace
  `dev.spectroscope` is verified. Details in [`RELEASING.md`](../RELEASING.md).
- A full **JDK** (for `jlink`) and **Node + npm** (for the web bundle + Electron).
- `gh` authenticated to `github.com/spectroscope/spectroscope`.

---

## The steps

### 1. Preflight
- Clean working tree; on `main`.
- Choose the version. Central is append-only → it must be higher than the last
  published (`git tag --list 'v*'`, and check central.sonatype.com).
- Skim `release-notes/v<next>.md` — the draft grows during development; the
  release day should be an edit, not archaeology.

### 2. Bump versions
Move together:
- **Maven libs:** `version` in `spectro-core/build.gradle.kts` and
  `spectro-orchestrator/build.gradle.kts`.
- **Apps (asset naming):** `version` in `spectro-cli`, `spectro-server`,
  `spectro-mcp-notes` build files and `spectro-desktop/package.json`.
- **Samples:** the Maven coordinates pinned in `samples/*/build.gradle.kts`
  (they resolve once step 6 publishes; the samples build standalone and are
  not part of the root gate).
- **The citation file:** `version` and `date-released` in `CITATION.cff`.
  GitHub renders it in the "Cite this repository" box on the repo front page,
  and it sat at 0.3.0 through two cuts before anyone clicked that box (found
  on 0.6.0 release day). tag.yml bumps both fields, and the stray grep below
  covers `*.cff`.
- **Then grep the tree for the OLD version string** (`grep -rn "0\.2\.0" --include='*.ts' --include='*.kts' --include='*.json' .`
  minus lockfiles and `*.test.ts` — test fixtures legitimately quote
  historical version strings): 0.2.0 shipped with `spectro-desktop/main.ts` still
  pinning `spectro-server-0.1.0.jar` — the desktop face died on a fresh
  clone. Version literals outside the build files are bugs; prefer globbing
  (the desktop launcher now globs the newest jar for exactly this reason).
- **And the QUOTED old version in shipped Java** (`git grep -n '"0\.2\.0"' -- '*.java' ':(exclude)*/src/test/*'`):
  Java source is invisible to the bump above, which is how
  `StarterBundles.VERSION` served 0.4.1 out of a 0.5.0 build (card 143). That
  constant is build-stamped now (`processResources` expands the module version
  into `starter/spectro-version.properties`), so any hit here means a version
  written by hand again. Quoted matches only — javadoc prose may honestly
  record which version a measurement ran against. tag.yml runs both greps.

### 3. Full gate — must be green before anything irreversible
```bash
./gradlew test --rerun-tasks --no-build-cache \
  :spectro-core:javadoc :spectro-orchestrator:javadoc   # JUnit + javadoc (warnings ok, errors abort)
( cd spectro-web && npm ci && npm run gate )             # tsc, eslint, prettier, vitest, vite build
```
**`--rerun-tasks --no-build-cache` is not optional.** On a warm tree a plain
`./gradlew test` reports `BUILD SUCCESSFUL` in half a second without running a
single test (UP-TO-DATE — and even `cleanTest test` comes back FROM-CACHE). A
release check that trusts that green has checked nothing; count the tests in
the output.

Baseline at v0.6.0: **JUnit 1275**, **vitest 2387** across 161 files (the
live-Opus contract check self-skips without a key). A new release should never
gate below the last one.
The javadoc leg is not decoration: at the 0.4.0 cut it caught three doc
comments orphaned from their methods by a mid-wave insertion — the only gate
that runs javadoc is this one.

### 4. Dry-run the publish (no portal)
```bash
./gradlew :spectro-core:publishToMavenLocal :spectro-orchestrator:publishToMavenLocal
```
Confirms GPG signing + POM generation. Check `~/.m2/repository/dev/spectroscope/…`:
every artifact has a `.asc`, and the orchestrator POM depends on `spectro-core:<v>`.

When the tag was cut by CI (`.github/workflows/tag.yml`), this step ran as
POM generation and the pin check only — no key lives in CI, and a keyless
publish would fail artifact validation on the declared `.asc` files. So a
CI-cut tag has proven the POMs, nothing more; the first `.asc` files appear
when this command, or step 6 itself, runs on the owner's machine.

### 5. Commit + tag
```bash
git add -A && git commit -m "release: cut v<v>"
git tag -a v<v> -m "spectroscope v<v>"
git push origin main && git push origin v<v>
```

### 6. Publish the libraries (IRREVERSIBLE)
```bash
./gradlew publishAndReleaseToMavenCentral --no-configuration-cache
```
Watch for `Uploaded bundle … deployment id …` → `being published to Maven Central`.
Then wait for propagation (minutes to hours) before trusting the coordinates:
```bash
python3 - <<'PY'
import urllib.request
for a in ("spectro-core","spectro-orchestrator"):
    u=f"https://repo1.maven.org/maven2/dev/spectroscope/{a}/<v>/{a}-<v>.pom"
    try: print(urllib.request.urlopen(u,timeout=20).status, a)
    except Exception as e: print("not yet", a, e)
PY
```

### 7. Build the release assets
```bash
./scripts/build-release-assets.sh          # all modules (host-arch desktop .dmg included)
# or just the desktop kit:
./scripts/build-desktop-runkit.sh
# on a box without a JDK/Node for Electron:
SKIP_DESKTOP=1 ./scripts/build-release-assets.sh
```
Everything lands in `build/release-assets/`.

### 8. GitHub release
```bash
gh release create v<v> --title "spectroscope v<v>" --notes-file <notes>.md build/release-assets/*
# or, adding to an existing release:
gh release upload v<v> build/release-assets/* --clobber
```

### 8b. Bump the Homebrew tap

The cask at github.com/spectroscope/homebrew-tap serves
`brew install --cask spectroscope/tap/spectroscope`. After the GitHub
release is up, in the tap repo:

```bash
scripts/bump-cask.sh <v>     # reads the DMG's sha256 from the release asset digest
brew audit --cask spectroscope/tap/spectroscope
git commit -am "bump to <v>" && git push
```

The script refuses when the release carries no dmg asset, so step 7's
desktop build is a prerequisite, not a suggestion.

### 8c. Build and attach the Linux kit

The Linux kit is the one desktop artifact CI can build end to end, because
nothing on Linux is signed: no Gatekeeper, no Developer ID, no notarization.
Dispatch it against the tag, not a branch:

```bash
gh workflow run linux-kit -f ref=v<v>
```

It builds the AppImage and the deb on an ubuntu runner, re-verifies the
llama-server closure, boots both under xvfb (health answered, JVM reaped),
asserts the deb's own Version field, and attaches both to the release for a
`vX.Y.Z` ref. The attach step refuses a ref that is not the tag it names: it
fetches the tag from origin and requires HEAD to be exactly that commit, so a
branch called `v0.4.2` cannot ferry bytes onto a release.

Development builds off `main` are stamped `<next>-dev.<sha>` and are for the
apt repository, never for a release.

### 9. Flip install snippets (only after step 6 resolves)
- **Landing** (`design/website/index.html`): "on Maven Central", enable the
  GitHub + Maven Central footer links → `python3 tools/sync_website_repo.py`,
  commit + push `spectroscope-website` (Cloudflare auto-deploys).
- **Portal** (`spectroscope-dev/public/index.html`): status "v<v> is out";
  regenerate docs `python3 tools/build_dev_docs.py`; commit + push
  `spectroscope-dev`.
- Push = deploy (~1 min). Verify the live copy before calling it done.

---

## The desktop run kit — details

`scripts/build-desktop-runkit.sh` produces a **self-contained** app: the Electron
shell (`spectro-desktop`) spawns and supervises the server, and the build bundles
the server jar, a **jlink'd JRE** *and* llama.cpp's **`llama-server`** into the
app, so the target machine needs no Java and no Homebrew. Double-click → server
starts with it → cockpit opens; the built-in model runs out of the box.

Mechanics:
1. `:spectro-server:bootJar` → copied to `spectro-desktop/build/spectro-server.jar`
   (the version-neutral path `package.json` `extraResources` points at).
2. `jlink --add-modules ALL-MODULE-PATH` from the host JDK → `spectro-desktop/jre`
   (full module set so Spring Boot's reflection is safe; ~160 MB, gitignored).
3. `scripts/fetch-llama-server.sh` → `spectro-desktop/bin`: llama.cpp's
   `llama-server` plus its dylib closure (11 Mach-O files, ~22 MB), pinned by
   build tag **and** tarball sha256. The script **fails the build** if any load
   path points outside the bundle. Without this step the packaged app falls
   back to a `llama-server` on the PATH — which only a Homebrew user has.
   `src/main.ts` passes the staged dir as `-Dspectro.bundle.bin`.
4. `resolveJavaBin()` in `src/main.ts` uses `Resources/jre/bin/java` when packaged,
   the PATH `java` in dev.
5. App icon: `icon.svg` → `icon.icns` (rsvg-convert + `sips` + `iconutil`; the
   committed `icon.icns` is the fallback when rsvg-convert is absent).
6. Signing is auto-selected (details in
   [DESKTOP-SIGNING.md](DESKTOP-SIGNING.md)): with a **Developer ID** in the
   keychain, the JRE and `bin/` are signed inside-out (hardened runtime +
   entitlements) *before* `electron-builder --dir`, the app is resealed and
   hard-verified, `hdiutil` packs the `.dmg`, and — when the notarytool
   profile is present — the dmg is **notarized and stapled**. Every shipped
   dmg since 0.2.0 went through this path. Without an identity: **ad-hoc**
   `codesign --force --deep --sign -` → verify → `hdiutil`.

**Why the two-phase build + explicit codesign:** electron-builder's "skip
signing" leaves an *invalid* bundle seal (`codesign --verify` fails with "code
has no resources but signature indicates they must be present"), and macOS calls
that **"damaged"** on download — worse than "unidentified developer". The
explicit codesign pass writes a valid seal in both modes. On the ad-hoc path
sign with `-` only — **never** a corporate/Valtech identity that
`security find-identity` may list.

**Verify it actually works** (not just that it built): launch the packaged
`.app`, confirm a `…/Resources/jre/bin/java` child bound a port and
`/api/health` returns `{"status":"ok"}`, quit and confirm the JVM is reaped, and
`codesign --verify --deep --strict` the app (pass = not "damaged").

### Known limits (be honest in the release notes)
- **Per-platform.** `electron-builder`, the JRE *and* the llama-server binary
  set are OS/arch specific; the script builds the **host** target only, and the
  pinned llama sha256 is the arm64 asset. Windows/Linux/Intel need building
  on/for each (and their own `LLAMA_SHA256`).
- **Notarized only on the release machine.** The script signs + notarizes when
  a Developer ID and the notarytool profile are present (every shipped dmg
  since 0.2.0 is notarized + stapled). On a machine without them it falls back
  to ad-hoc signing: macOS then shows *"unidentified developer"* →
  **right-click → Open** once (or `xattr -cr`). Setup:
  [`docs/DESKTOP-SIGNING.md`](DESKTOP-SIGNING.md). (A local build has no
  quarantine flag, so it launches directly — which is why the verify step
  above works without any prompt.)

---

## Gotchas
- **Append-only Central:** a botched publish can't be pulled — only superseded by
  a higher version. Hence the dry-run + full gate before step 6.
- **Spring Boot on Maven:** `spectro-server` is an app; its plain `jar` is a thin,
  non-runnable shell. It ships as a GitHub asset (bootJar), never to Maven.
- **Tag vs. assets:** keep `v<v>` pointing at the commit the assets are built from.
  If you fix a build script after tagging, move the tag (`git tag -f`, force-push)
  while the release is fresh and unconsumed.
- **`jre/` and `build/`** are gitignored build artifacts — never commit them.
- **Fresh-clone smoke BEFORE the tag (0.2.0 lesson):** both 0.2.0 launcher
  bugs (`./spectro desktop` dead on a version-pinned jar path, `./spectro
  web --port N` silently ignored) only surfaced on a fresh clone
  (`spectroscope-cloned/` in the product home is the standing test copy).
  Minimum smoke there: `./spectro doctor`, `./spectro web --port 8097`
  (server must come up on 8097), `./spectro desktop`. Dev-tree behaviour
  proves nothing about a clone.
- **`CSC_NAME` wants the identity WITHOUT the "Developer ID Application: "
  prefix** (0.2.0 signing lesson) — details in
  [DESKTOP-SIGNING.md](DESKTOP-SIGNING.md); the build script handles it, do
  not "fix" it back.

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

---

## What a release contains

| Artifact | Where | How |
|---|---|---|
| `dev.spectroscope:spectro-core` | Maven Central | `publishAndReleaseToMavenCentral` |
| `dev.spectroscope:spectro-orchestrator` | Maven Central | same (POM pins core at the same version) |
| `spectro-<v>.zip` (CLI) | GitHub release asset | `scripts/build-release-assets.sh` |
| `spectro-server-<v>.jar` | GitHub release asset | ″ |
| `spectro-mcp-notes-<v>.zip` | GitHub release asset | ″ |
| `spectro-web-<v>.zip` (built UI) | GitHub release asset | ″ |
| `spectroscope-<v>-<arch>.dmg` (desktop run kit) | GitHub release asset | `scripts/build-desktop-runkit.sh` |

Rule of thumb: **every module ships something.** Libraries go to Maven; the CLI,
server, mcp-notes, web and desktop go to the GitHub release. `spectro-web` and
`spectro-desktop` are npm/frontend modules and can never go to Maven Central.

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

### 2. Bump versions
Move together:
- **Maven libs:** `version` in `spectro-core/build.gradle.kts` and
  `spectro-orchestrator/build.gradle.kts`.
- **Apps (asset naming):** `version` in `spectro-cli`, `spectro-server`,
  `spectro-mcp-notes` build files and `spectro-desktop/package.json`.

### 3. Full gate — must be green before anything irreversible
```bash
./gradlew test :spectro-core:javadoc :spectro-orchestrator:javadoc   # JUnit + javadoc (warnings ok, errors abort)
( cd spectro-web && npx vitest run )                                  # vitest
```
Baseline at v0.1.0: **JUnit 678** (1 skipped = the live-Opus test), **vitest 383**.

### 4. Dry-run the publish (no portal)
```bash
./gradlew :spectro-core:publishToMavenLocal :spectro-orchestrator:publishToMavenLocal
```
Confirms GPG signing + POM generation. Check `~/.m2/repository/dev/spectroscope/…`:
every artifact has a `.asc`, and the orchestrator POM depends on `spectro-core:<v>`.

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
both the server jar *and* a **jlink'd JRE** into the app, so the target machine
needs no Java. Double-click → server starts with it → cockpit opens.

Mechanics:
1. `:spectro-server:bootJar` → copied to `spectro-desktop/build/spectro-server.jar`
   (the version-neutral path `package.json` `extraResources` points at).
2. `jlink --add-modules ALL-MODULE-PATH` from the host JDK → `spectro-desktop/jre`
   (full module set so Spring Boot's reflection is safe; ~160 MB, gitignored).
3. `resolveJavaBin()` in `src/main.ts` uses `Resources/jre/bin/java` when packaged,
   the PATH `java` in dev.
4. `electron-builder` (unsigned) → `spectro-desktop/release/spectroscope-<v>-<arch>.dmg`.

**Verify it actually works** (not just that it built): launch the packaged
`.app`, confirm a `…/Resources/jre/bin/java` child bound a port and
`/api/health` returns `{"status":"ok"}`, then quit and confirm the JVM is reaped.

### Known limits (be honest in the release notes)
- **Per-platform.** `electron-builder` + the JRE are OS/arch specific; the script
  builds the **host** target only. Windows/Linux/Intel need building on/for each.
- **Unsigned.** No Apple Developer cert → on download macOS Gatekeeper blocks the
  first launch: **right-click → Open**. (A local build has no quarantine flag, so
  it launches directly — which is why the verify step above works without the prompt.)

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

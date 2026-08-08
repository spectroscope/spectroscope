# The tracked web bundle, and what to do when it conflicts

`spectro-web/vite.config.ts` writes the built UI into
`spectro-server/src/main/resources/static`, and those 15 files are **tracked**.
This document says why, what it costs, and the one command that resolves a
conflict correctly. Card 184.

## Why it is tracked

So that `./gradlew :spectro-server:bootJar` produces a working server on a
machine with a JDK and no JavaScript toolchain.

That is not hypothetical, and it is not only about contributors. **CI's own
`java-gate` is that consumer.** Measured on `9d669da`:

| | |
|---|---|
| `.github/workflows/gate.yml`, `java-gate` | no `setup-node`, never runs `npm ci` |
| `spectro-server/build.gradle.kts`, `processResources` | copies skills only — no vite, no `Exec` |
| `StaticCacheHeadersTest.java:47` | reads `static/assets` off the classpath **unconditionally**, and fails with *"no index-\*.js in static/assets — was the web bundle built?"* if it is absent |

Every path that produces a *shippable* artifact rebuilds the bundle from source
anyway (`build-release-assets.sh:35`, `build-desktop-runkit.sh:128`, and both CI
workflows). The tracked copy carries the no-Node case, and `java-gate` is it.

## What it costs

Measured on main at 0.7.0:

| | |
|---|---|
| tracked bundle | 15 files, 1.9 MB |
| commits on main touching it | 199 of 510 — **39%** |
| bundle blobs in history | 524, 244 MB uncompressed |
| v0.6.1 → v0.7.0 | 48 merges, 100 commits touching the bundle |

## What a conflict actually looks like

Not one file. Measured with two branches that touch **different** source files,
so the sources merge cleanly:

```
source conflicts   0
bundle conflicts  10   9 × rename/rename on hashed assets, plus index.html
```

The nine are rename/rename because the filenames are content-hashed:
`index-IWvb4Los.js` became `index-Da_Pg42M.js` on one side and
`index-BCQ1Y-Ci.js` on the other, and git reports that as one file renamed two
ways. `index.html` conflicts on content because it lists those names.

**This is why a git merge driver is not the answer**, and it was tried before
this document was written. A merge driver resolves *content*; it never sees a
rename/rename, which is resolved at the path level. Wired up, it cleaned up
`index.html` and left all nine assets conflicted — one file out of ten — while
adding a per-checkout install step, because a driver is defined in `.git/config`
and `.git/config` is never cloned.

## The one command

```bash
scripts/resolve-web-bundle.sh
```

It rebuilds from the merged source and stages the directory. `emptyOutDir` means
the build writes the right files and deletes the losing branch's stale ones;
staging then clears all ten conflicted paths at once.

```bash
git merge some-branch          # 10 conflicts under static/
scripts/resolve-web-bundle.sh
git commit
```

If `spectro-web` itself is conflicted, the script refuses and says so. The
bundle is built *from* those files, so a human resolves them first.

**Why rebuilding rather than choosing:** the rebuilt bundle carries **both**
branches' changes. Verified — two probe branches, each adding a distinguishable
string through a different source file, both strings present in the merged
`index-*.js`, under a hash belonging to neither branch. Picking either side
keeps one and silently drops the other, and nothing downstream would notice.

## What this does not fix

The 39% churn and the 244 MB already in history. Untracking would stop the
growth, but it would also mean adding Node, `npm ci` and a vite build to
`java-gate` ahead of the Java tests, and `tag.yml` picks the rebuilt bundle up
through `git add -A`, so the release commit would need the same change or the
tag would stop carrying the UI. That trade is the rest of card 184.

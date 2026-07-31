# CI setup — what to click in GitHub, in order

This guide configures the repository for the three workflows in
`.github/workflows/`:

| workflow | trigger | what it does |
|---|---|---|
| `gate.yml` | push to `main`, every pull request | runs the Java gate (`java-gate`) and the web gate (`web-gate`) in clean checkouts and reports the real test counts |
| `tag.yml` | manual (`Run workflow`), version input | release playbook steps 1–5: preflight, version bump, full gate, dry-run publish, commit + annotated tag. Stops at the tag. |
| `agent.yml` | `@claude` mention on issues and pull requests | answers with Claude Code — explains a failing gate, triages an alert, reviews a diff against the house rules |

Everything after the tag — the Maven Central publish, Developer ID signing,
the GitHub release, the snippet flip — stays on the owner's machine on purpose.
`docs/RELEASE-PLAYBOOK.md` steps 6–9 cover it. Nothing in this guide puts a
signing key or a portal token into GitHub.

Work through the sections in order. Each one is a page in the repository's
**Settings** (you need admin rights), except section 5 and 6, which run the
workflows.

---

## 1. Enable Actions and set default workflow permissions to read-only

**Settings → Actions → General**

1. Under **Actions permissions**, select **Allow all actions and reusable
   workflows** (or, stricter, allow only actions created by GitHub plus
   `anthropics/claude-code-action@*` — those are the only third-party actions
   the workflows use).
2. Under **Workflow permissions**, select **Read repository contents and
   packages permissions** (read-only).
3. Check **Allow GitHub Actions to create and approve pull requests**. This
   is what lets `tag.yml` open the release pull request; without it the cut
   dies at its last step with "GitHub Actions is not permitted to create or
   approve pull requests" (measured on walk 30616661551). Merges stay gated
   by the required checks either way, and no workflow here approves
   anything.
4. Save.

Why read-only as the default: two of the three workflows never need to write
to the repository, and every action they pull in runs with the job's token.
With a read-only default, a compromised or misbehaving action in the gate can
at worst read public code. The one workflow that must write — `tag.yml`, which
commits a version bump and pushes a tag — declares `permissions: contents:
write` for itself, explicitly, and nothing more. Elevation is visible in the
workflow file instead of ambient.

## 2. Require the gate on main

**Settings → Rules → Rulesets → New ruleset → New branch ruleset**
(or the classic path: **Settings → Branches → Add branch protection rule**)

1. Name it (e.g. `main-gate`), set **Enforcement status** to Active.
2. **Target branches**: add the default branch (`main`).
3. Enable **Require status checks to pass** and add these two checks, by the
   exact job names from `gate.yml`:
   - `java-gate`
   - `web-gate`
4. Recommended: enable **Require a pull request before merging** so the checks
   actually stand between a change and `main`.
5. **Bypass list** — one entry, allowed to bypass **always** (not "for pull
   requests only"): the **Repository admin** role, so the owner's direct
   pushes to `main` (including the release-notes and cleanup pushes in
   section 6d) are not rejected by the rule.

   A note from the first walk, measured as GH013 on run 30616343650: on a
   user-owned repository the **GitHub Actions app cannot be a bypass
   actor** (the API refuses the integration), so `tag.yml` never pushes
   `main` directly. It pushes a `release/v*` branch plus the tag — tags are
   not governed by the branch ruleset — and opens the release pull request;
   the bump reaches `main` through the same checks as every other change.
6. Create the ruleset.

Note: the status-check picker only lists checks that have run at least once.
If `java-gate` and `web-gate` do not appear, open a trivial pull request
first, let the gate run, then come back and add them.

## 3. Create the `release` environment with a required reviewer

**Settings → Environments → New environment**

1. Name it exactly `release` — this must match the `environment: release`
   line in `tag.yml`.
2. Under **Deployment protection rules**, enable **Required reviewers** and
   add the owner (or whoever approves releases).
3. Optional but recommended: under **Deployment branches and tags**, choose
   **Selected branches and tags** and allow only `main`, so the workflow
   cannot be dispatched from any other ref.
4. Save protection rules.

Why: `tag.yml` is the one workflow with write access, and a workflow that can
move a tag can move the wrong one. Because it declares `environment: release`,
every run — including a mistyped version on a bad afternoon — pauses before
its first step until a listed reviewer approves it in the GitHub UI. The
approval is the human in the loop; the version input is on screen at approval
time, so read it before clicking.

## 4. Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| secret | used by | what it is and what it costs |
|---|---|---|
| `ANTHROPIC_API_KEY` | `agent.yml` | An Anthropic API key. Every `@claude` mention starts a Claude Code run billed against that key's account, so treat it like a metered credential: scope it to a workspace with a spend limit if your Anthropic console supports it, and rotate it if it leaks. |

That is the whole list. `GITHUB_TOKEN` is provided automatically per job; you
never create it.

The following secrets do **not** exist, by design — do not add them:

| deliberately absent | why |
|---|---|
| Maven Central portal token | Central is append-only; the irreversible publish (playbook step 6) is made by a person on the owner's machine, never by a workflow. Nothing in `tag.yml` references a publish credential or the `publishAndReleaseToMavenCentral` task. |
| GPG signing key | The CI cut generates and checks the publication POMs; it never publishes, so it needs no key (a keyless publishToMavenLocal fails artifact validation on the declared .asc files — measured on the first walk). GPG signing itself is confirmed on the owner's machine when step 6 runs there. |
| Apple Developer ID certificate / notary credentials | Desktop signing and notarization (playbook step 7) stay on the owner's machine. A code-signing identity does not belong in a third party's secret store to save a step that runs a few times a month. |

`agent.yml` needs one more thing that is not a secret: the **Claude GitHub
App** (<https://github.com/apps/claude>) must be installed on this repository
— open the app page, click **Install**, select this repository. The action
exchanges the workflow's OIDC token through that app for its GitHub
credential (that is what `id-token: write` in `agent.yml` is for). With the
API key set but the app missing, the job fails at authentication on the
first `@claude` mention: the key pays for the model, the app grants the
GitHub access, and both are required.

## 5. Running the tag workflow

**Actions → tag → Run workflow**

1. Select branch `main`.
2. Enter the **version** (plain, no `v` prefix — e.g. `0.4.2`).
3. Click **Run workflow**, then approve the run when the `release`
   environment asks for review.

What it does — release playbook steps 1–5, and not one step further:

1. **Preflight**: `release-notes/v<version>.md` must exist; the tag
   `v<version>` must not exist locally or on origin; Maven Central must
   answer 404 for the coordinates (a 200 aborts — Central is append-only and
   the version is already burned).
2. **Bump versions** across the build files.
3. **Full gate**: the same commands as `gate.yml`, flags included, in the
   clean CI checkout.
4. **Dry-run publish** to the runner's local Maven repository (signing
   excluded, see section 4), verifying that the orchestrator POM pins
   `spectro-core` at exactly `<version>`.
5. **Commit + tag**: commits `release: cut v<version>` as Christopher Ezell
   `<chris@spectroscope.ai>` on a `release/v<version>` branch, creates the
   annotated tag `v<version>`, pushes both, and opens the release pull
   request (the bump reaches `main` through the same required checks as
   every other change; merge it with a merge commit or rebase, never
   squash, so the tagged commit stays an ancestor of `main`).

The tag is the handoff artifact. A gate that ran in a clean environment from
a clean checkout is a stronger claim than the same gate on a warm working
machine — that is what moving steps 1–5 online buys.

Then, on the owner's machine:

```bash
git fetch --tags
git checkout v<version>
```

and continue with `docs/RELEASE-PLAYBOOK.md` steps 6–9: publish the libraries
to Maven Central, build and sign the release assets, create the GitHub
release, flip the install snippets.

## 6. First-run proofs

Run this ritual once after setup, and again after any change to the workflow
files. Each proof maps to an acceptance criterion; a pipeline that has not
failed on purpose has not been tested.

**(a) A failing test must fail the gate.** Create a branch, flip one
assertion in any Java test (and, separately or in the same pass, one in a
`spectro-web` test), open a pull request. Both `java-gate` and `web-gate`
must go red. Delete the branch afterwards.

**(b) Read the counts, not the tick.** On any green run, open the job and
read the **Summary**: the Java job reports the JUnit totals aggregated from
the XML result files, the web job reports the vitest count parsed from its
output, and both jobs fail outright if their count is zero. This exists
because on this tree a plain `./gradlew test` reports `BUILD SUCCESSFUL` in
half a second while executing zero tests — Gradle's up-to-date check skips
the whole task. The workflows always pass `--rerun-tasks --no-build-cache`,
and the zero-count check is the proof that the flags did their job. A green
tick with no count next to it proves nothing here; do not get into the habit
of trusting it.

**(c) The javadoc leg must catch a broken doc comment.** On a branch, break
a doc comment in `spectro-core` — for example an unclosed `{@link` or a
`@param` naming a parameter that does not exist — and push. The `java-gate`
job must go red on the javadoc leg of its **Java gate** step (javadoc is part
of that one Gradle invocation, not a separate step). This is the class of
break that once reached a
release cut before anything ran javadoc; the gate now runs it on every push
so it cannot travel that far again.

**(d) Walk the tag workflow once on a throwaway version.** The preflight
accepts only plain `X.Y.Z` — a suffix like `-test` is rejected before
anything runs — so the throwaway must itself be plain. Use `0.0.999`: it
sorts below every published version, reads as a test at a glance, and Maven
Central answers 404 for it, so the preflight passes. Create
`release-notes/v0.0.999.md` on `main` (one placeholder line is enough; with
the section-2 ruleset active, this direct push relies on the admin bypass
from that section), and dispatch the tag workflow with version `0.0.999`.
When it finishes:

```bash
git fetch --tags
git checkout v0.0.999
# confirm playbook step 6 would start cleanly from here:
git status                 # clean tree, detached at the tag
./gradlew :spectro-core:publishToMavenLocal :spectro-orchestrator:publishToMavenLocal
                           # signing runs for real on this machine — every
                           # artifact in ~/.m2 gets its .asc
```

Do **not** run `publishAndReleaseToMavenCentral` with the throwaway version.
Then clean up:

```bash
git checkout main && git pull
git tag -d v0.0.999
git push --delete origin v0.0.999
git revert <sha-of-"release: cut v0.0.999">   # undo the version bump
git rm release-notes/v0.0.999.md              # fold into the revert or a follow-up commit
git push origin main
```

One walk of this loop proves the whole handoff: CI produced a tag, the tag
checked out, and the first machine-side step would have started cleanly.

## 7. The dirty tree after the web gate — expected, accepted

`npm run gate` ends in `vite build`, and vite's output directory is
`spectro-server/src/main/resources/static` — tracked files inside the server
module, rewritten with newly hashed asset names on every build. So the web
gate **mutates the checkout by design**, and a CI job that ran the gate and
then asserted `git status` is clean would fail on its own output.

This is accepted, and `gate.yml` says so in a comment where it happens: the
CI checkout is a throwaway, nothing reads the mutated files afterwards, and
the runner is discarded with them. Do not add a clean-tree check after the
web gate, and do not "fix" the mutation by committing the bundle from CI.
Whether the built bundle should be committed at all (and by whom) is a
long-standing open owner call about bundle-commit policy; this pipeline
deliberately does not decide it — it only refuses to be surprised by it.

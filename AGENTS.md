# spectroscope — rules for agents working in this repo

One repo, three faces: a Java agent harness (five lines to a running agent), a
fleet orchestrator, and a web cockpit that watches both. Everything here is
public. Business English throughout: code, comments, commits, docs.

## module map

- `spectro-core` — the harness: agent loop, providers, tools, the permission
  gate, JSONL tracing. Published to Maven Central.
- `spectro-orchestrator` — the fleet: bus envelopes, TCP hub, panel lanes.
  Published to Maven Central.
- `spectro-cli` — the `spectro` command-line launcher.
- `spectro-server` — the Spring server: REST + WebSocket, serves the committed
  web bundle.
- `spectro-mcp-notes` — the sample MCP server.
- `spectro-web` — the React/Vite cockpit. Its build lands inside spectro-server.
- `spectro-desktop` — the Electron shell that bundles server + JRE into the
  desktop run kit.

Toolchain floor: JDK 21+, Node 20+.

## the gates

Java — always with both flags and all five javadoc legs. This is the gate, and
CI runs it on every push and pull request:

    ./gradlew test --rerun-tasks --no-build-cache :spectro-core:javadoc :spectro-orchestrator:javadoc :spectro-server:javadoc :spectro-cli:javadoc :spectro-mcp-notes:javadoc

A plain `./gradlew test` reports green on this tree in half a second while
running zero tests: Gradle's up-to-date check skips the whole task, and even
`cleanTest test` comes back FROM-CACHE. The flags force real execution. Count
the tests in the output; never trust the tick. (Dependency resolution caching
is fine. The flags disable task and build caching, not resolution.)

The javadoc legs ride along because javadoc runs nowhere else in the build. A
refactor once orphaned three doc comments from their `stream()` methods and
nothing caught it until release day; the gate now catches that class of break
on every push. Every module carries a leg, not only the two that publish to
Maven: while the list was short, an orphaned `@param` in spectro-server sat in
the tree for a day with the gate green over it.

Web, from `spectro-web/`:

    npm ci && npm run gate

The gate is `tsc -b && eslint . && prettier --check . && vitest run && vite build`.
The final `vite build` writes into `spectro-server/src/main/resources/static/`,
where the committed bundle lives, so the gate mutates tracked files by design.
Restart a running spectro-server afterwards or it serves the stale bundle.

Concurrency suites (bus, hub, fleet) must pass three consecutive runs before a
release. No API key is required; the single live contract test skips itself.

## frozen surfaces

- The five-lines facade on `Spectro` is FROZEN: the five lines compile and run
  exactly as written, pinned by `SpectroApiTest`. New setters may join; these
  stay. Deviating needs an owner decision, not a refactor.
- The RunEvent JSONL wire is additive, never breaking: new event types and new
  optional fields only. Files recorded by old versions stay loadable.
- `spectro-web/src/styles/` and `src/i18n/i18n.ts` are deliberately
  prettier-ignored: one line per rule, one line per key, so they scan and diff
  like tables. Keep that shape and do not format them.

## how to work

- TDD, red first: write the failing test, watch it fail, then make it pass.
- A claim needs a measurement. Quote counts ("1158 tests, 0 failures"), not
  ticks. A component's own success signal is not evidence; see
  `docs/LESSONS-VERIFYING-MODEL-FEATURES.md` and `docs/LESSONS-TRANSLATION.md`.
- Comments state constraints the code cannot show: the invariant being
  enforced, the reason a flag exists. Full sentences. Headings and UI copy are
  lowercase.

## the release boundary

CI stops at the tag. Maven Central is append-only, so the publish, and the
Developer ID signing of the desktop kit, happen on the owner's machine against
a checked-out tag (`docs/RELEASE-PLAYBOOK.md`, steps 6 to 9). Never add portal
credentials or signing certificates to CI, and never write a workflow that can
reach Maven Central.

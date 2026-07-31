<p align="center">
  <a href="https://spectroscope.ai">
    <img src="docs/brand/hero-banner.png" alt="spectroscope, agent orchestrator. spawn in five lines. watch every line." width="960">
  </a>
</p>

<p align="center">
  <em>the agent orchestrator you can watch. every event is like a spectral line, every agent a lane on the screen.</em>
</p>

<p align="center">
  <a href="https://github.com/spectroscope/spectroscope/actions/workflows/gate.yml"><img src="https://img.shields.io/github/actions/workflow/status/spectroscope/spectroscope/gate.yml?branch=main&label=gate" alt="gate: the full test suites on every push"></a>
  <a href="https://central.sonatype.com/artifact/dev.spectroscope/spectro-core"><img src="https://img.shields.io/maven-central/v/dev.spectroscope/spectro-core?label=maven%20central&color=CE9440" alt="maven central"></a>
  <a href="https://github.com/spectroscope/spectroscope/releases"><img src="https://img.shields.io/github/v/release/spectroscope/spectroscope?label=release&color=2DD4A7" alt="github release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/code-MIT-2CB1C4" alt="code license MIT"></a>
  <a href="LICENSE-ASSETS.md"><img src="https://img.shields.io/badge/images-CC%20BY%204.0-8B7CF0" alt="images CC BY 4.0"></a>
  <a href="https://github.com/spectroscope/spectroscope/releases/latest"><img src="https://img.shields.io/badge/macOS%20app-signed%20%2B%20notarized-C05A4C" alt="macOS app signed and notarized"></a>
  <img src="https://img.shields.io/badge/java-21%2B-5C5142" alt="java 21+">
</p>

<p align="center">
  <a href="https://spectroscope.ai">website</a> ·
  <a href="https://spectroscope.ai/guide/">user guide</a> ·
  <a href="https://spectroscope.dev">dev docs</a> ·
  <a href="https://gallery.spectroscope.ai">gallery</a> ·
  <a href="https://github.com/spectroscope/spectroscope/releases">releases</a> ·
  <a href="release-notes/">release notes</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/20-spectrum-brand.png">
  <img src="docs/guide-assets/shots-light/20-spectrum-brand.png" alt="the spectrum tab: four agents reviewing a pull request in parallel, each one a lane of colored event ticks">
</picture>
<p align="center"><sub><b>the spectrum</b> · four agents review a pull request in parallel; every event is a tick on its agent's lane</sub></p>

## watch deeper

spectroscope is a JVM agent harness and fleet orchestrator. One Java core drives
every face: a terminal REPL, headless runs, a Spring Boot web UI, a signed macOS
desktop app, an MCP example server, and a fleet of agents on a shared bus.

Everything an agent does lands in one stream of typed JSONL `RunEvent`s, the
same wire format on every face. The UI reads that stream the way a spectroscope
reads light: watch it live, store it as plain files, replay it step by step,
lens it for reasoning and timing, and answer permission gates while the run
waits. There is no separate telemetry stack to deploy; the session file is the
record.

spectroscope began as the reference harness of a build-an-agent-harness
workshop and grew into its own product.

## five lines to an agent

```java
var agent = Spectro.agent()
    .model(Anthropic.opus())
    .tools(Tools.readFile(), Tools.runCommand())
    .workspace(Path.of("/tmp/scratch"));

for (RunEvent event : agent.run("Write hello.py and run it")) {
    System.out.println(event);   // the stream IS the observability
}
```

The same style scales to a fleet: `Spectro.panel()` runs several lanes as full
agents on a shared bus and hands you one merged event stream. Both artifacts
are on Maven Central:

```kotlin
implementation("dev.spectroscope:spectro-core:0.4.1")
implementation("dev.spectroscope:spectro-orchestrator:0.4.1")   // fleets
```

## the tour

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/21-trace-lens-brand.png">
        <img src="docs/guide-assets/shots-light/21-trace-lens-brand.png" alt="the trace tab with the reasoning lens open">
      </picture>
      <br><sub><b>the trace</b> · every frame with its causal chain, a reasoning lens, and a replay scrubber</sub>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/23-permission-dialog.png">
        <img src="docs/guide-assets/shots-light/23-permission-dialog.png" alt="a run paused at the permission gate">
      </picture>
      <br><sub><b>the gate</b> · writes and commands wait for allow or deny; every decision lands in the stream</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/27-fleet-canvas.png">
        <img src="docs/guide-assets/shots-light/27-fleet-canvas.png" alt="the fleet canvas with spawn edges between agent nodes">
      </picture>
      <br><sub><b>the fleet canvas</b> · spawn edges and per-node spectral lines, live from the bus</sub>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/28-fleet-machine-room.png">
        <img src="docs/guide-assets/shots-light/28-fleet-machine-room.png" alt="the machine room: a composed system diagram of a running fleet">
      </picture>
      <br><sub><b>the machine room</b> · a running fleet as one composed system diagram, scrubbable in time</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/22-thinking-live.png">
        <img src="docs/guide-assets/shots-light/22-thinking-live.png" alt="chat with the model's thinking streaming live">
      </picture>
      <br><sub><b>thinking, live</b> · the model's self-report streams next to what it then did</sub>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/30-text-explain.png">
        <img src="docs/guide-assets/shots-light/30-text-explain.png" alt="the text feed with the explain panel open">
      </picture>
      <br><sub><b>explain</b> · an LLM reading of the whole run, honestly labeled as a reading</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/33-leveling-intro.png">
        <img src="docs/guide-assets/shots-light/33-leveling-intro.png" alt="the leveling intro on a fresh home: grow into it, or open everything now">
      </picture>
      <br><sub><b>grow into it</b> · a fresh home starts small and asks; an existing home is never asked and never locked</sub>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/34-leveling-panel.png">
        <img src="docs/guide-assets/shots-light/34-leveling-panel.png" alt="the leveling progress panel: criteria with ticks and receipts, the spectrum strip filling per level">
      </picture>
      <br><sub><b>the ladder</b> · levels tick from observed usage, every tick with a receipt into the session it happened in</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/guide-assets/shots/42-local-chooser.png">
        <img src="docs/guide-assets/shots-light/42-local-chooser.png" alt="the built-in model chooser: five local models with tool badges, sizes and a machine-fit line per row">
      </picture>
      <br><sub><b>no key, no cloud</b> · pick a local model, see whether your machine holds it, download once — tools included</sub>
    </td>
    <td width="50%"></td>
  </tr>
</table>

More in the [gallery](https://gallery.spectroscope.ai) and the
[user guide](https://spectroscope.ai/guide/), both in light and dark.

## run it

Grab a [release](https://github.com/spectroscope/spectroscope/releases): the
desktop run kit for macOS (arm64, Developer ID signed and notarized, bundles
its own JRE — and, from v0.4.0, its own `llama-server`, so the built-in model
needs nothing installed), the CLI zip, the server jar, or the mcp-notes zip. Or run from source with the `./spectro`
launcher, which resolves a JDK 21+ for you and loads the gitignored `./.env`:

```bash
./spectro web start   # web UI → http://127.0.0.1:8080, in the background
./spectro web         # what the web group can do, and whether it is running
./spectro repl        # terminal REPL
./spectro run -p "…"  # headless run
./spectro desktop     # Electron desktop app
./spectro doctor      # environment check
./spectro tour        # guided feature tour
```

It also knows `cron`, `sessions`, `resume <id>`, `level` and `mcp-notes`. Raw Gradle
works too (JDK 21+ as `JAVA_HOME`):

```bash
./gradlew build                                  # everything + all tests
./gradlew :spectro-server:bootRun                # the web face
(cd spectro-web && npm install && npm run build) # rebuild the UI into the server jar
```

The web build writes into `spectro-server/src/main/resources/static/`, where
the committed bundle lives, so rebuilding it dirties tracked files by design.
Web development wants Node 20+.

## observability, built in

The core has a tracing seam, and two sinks ship with it: the JSONL session
file (always on, the source of truth) and an **OTLP exporter** that maps
sessions to GenAI-semconv spans. Point it at Langfuse, Jaeger, or any OTLP
endpoint under settings, observability; `spectro doctor` probes the endpoint
with an empty batch and tells you whether it answers. Details in
[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## how it is built

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/00-one-core-five-faces.svg">
  <img src="docs/diagrams/light/00-one-core-five-faces.svg" alt="architecture overview: one core, five faces">
</picture>

| module | what it is |
|---|---|
| `spectro-core` | the agent loop, providers, tools, permission gate, sessions, tracing seam |
| `spectro-cli` | terminal face: REPL, headless runs, doctor, tour, scheduler |
| `spectro-server` | Spring Boot web face: WebSocket stream + REST, serves the built UI |
| `spectro-web` | the React UI (Vite): chat, spectrum, trace, graph, text, lab |
| `spectro-desktop` | Electron shell that spawns and supervises the server jar |
| `spectro-mcp-notes` | bundled example MCP server (notes search/add over stdio) |
| `spectro-orchestrator` | the fleet: lanes as full agents on a shared bus, one merged stream |

Runs on Spring and almost nothing else. Seventeen hand-built architecture
diagrams live in [docs/diagrams/](docs/diagrams/), each in both themes;
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/WEB-UI.md](docs/WEB-UI.md) go deep.

## providers

Seven chat providers, switchable mid-session from the header picker with
history intact:

| provider | runs | needs |
|---|---|---|
| `built-in` | local, via llama-server | nothing with the desktop app, which bundles one; with the server jar, `brew install llama.cpp` |
| `anthropic` | cloud | `ANTHROPIC_API_KEY` |
| `ollama` | local | a running Ollama |
| `openai` | api.openai.com or any compatible server | `OPENAI_API_KEY` (optional for local servers) |
| `lmstudio` | local | LM Studio's server |
| `openrouter` | cloud | `OPENROUTER_API_KEY` |
| `gemini` | cloud | `GEMINI_API_KEY` |

The built-in provider is the no-setup path: the app offers a small catalogue
of open models (Qwen3 1.7B/4B/8B, Qwen2.5 Coder 7B, VibeThinker 3B), says
which of them can drive the agent's tools and whether your machine has the
memory and disk for each, then downloads your pick sha256-pinned — four of
them from Qwen's own repository, VibeThinker from a community requantization
of WeiboAI's model. Each row links its licence and its source. The desktop
app carries its own `llama-server`, so nothing else needs installing; with the
server jar you bring your own (`brew install llama.cpp`) and the chooser says
so when it is missing. No key and no account, and the model itself runs on
your machine.

Keys are set once, in the UI (masked, written to `~/.spectro/.env` with mode
0600) or via CLI `set-key`; one Gemini or OpenAI key serves chat and the
`generate_image` tool alike. Config layers from env up to per-workspace
settings files; `spectro doctor` names anything shadowed.

Beyond that, the tool belt covers files, shell, sandboxed grep and glob, web
fetch, tiered web search, JS-capable page browsing through the system Chrome,
image generation, subagents, skills, and MCP servers, all behind the same
permission gate.

## tested

The v0.4.1 gate: 959 JUnit tests and 1003 vitest tests, all green before the
release cut. The suites run without any API key; provider wire mappings
are tested against scripted local servers, and the one live contract check
skips itself unless a key is set. Concurrency suites (bus, hub, fleet) pass
three consecutive runs before a release.

## docs

- [user guide](https://spectroscope.ai/guide/), 120+ pages, HTML and PDF, light and dark editions, real captured screens
- [dev portal](https://spectroscope.dev) with a generated, searchable reference extracted from this source tree
- [samples/](samples/) — standalone, runnable examples against the published Maven artifacts: the five lines, fleets, session recording, OTel export, a LangChain4j bridge
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/WEB-UI.md](docs/WEB-UI.md), [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md), [docs/INTEROP.md](docs/INTEROP.md)
- [release-notes/](release-notes/) for what each version brought

Found a bug or a rough edge? Open an issue; the project is young and moves
fast.

## license and credit

Two licenses, one rule: the name stays attached.

**Code: [MIT](LICENSE)**, copyright Christopher Ezell. Use it, fork it, ship
it, sell with it; the one thing the license asks is that the copyright notice
travels with copies of the code. Stripping it ends the license.

**Images: [CC BY 4.0](LICENSE-ASSETS.md)** for the screenshots, the
architecture diagrams and the banner. Reuse them in posts, talks, papers or
products, commercially too, as long as visible attribution stays with them:
*"spectroscope — Christopher Ezell, github.com/spectroscope/spectroscope,
CC BY 4.0"*. The spectroscope logo and wordmark are the exception: fine for
referring to the project, not for branding something else —
[LICENSE-ASSETS.md](LICENSE-ASSETS.md) has the exact terms.

If spectroscope shows up in your product or your research, a mention with a
link back is very welcome. GitHub reads [CITATION.cff](CITATION.cff),
so "cite this repository" in the sidebar gives you a ready-made reference.

# spectroscope — the agent orchestrator you can watch

One Java core drives every face: a terminal REPL, headless runs, a Spring web
UI, an Electron desktop shell, an MCP server, and a fleet orchestrator. Every
run is a stream of JSONL `RunEvent`s, the same wire format on every face, so
anything the agent does can be watched live, stored, and replayed. spectroscope
began as the reference harness of a build-an-agent-harness workshop and grew
into its own product.

**Architecture docs (with Mermaid):** [`docs/`](docs/) —
[ARCHITECTURE.md](docs/ARCHITECTURE.md) (core, providers, launcher, desktop) and
[WEB-UI.md](docs/WEB-UI.md) (state pipeline, design system, Lab).
**User guide:** [docs/USER-GUIDE.html](docs/USER-GUIDE.html) (dark) /
[docs/USER-GUIDE-LIGHT.html](docs/USER-GUIDE-LIGHT.html) — 120 pages, also as
PDF next to each.

## Run it

The `./spectro` launcher is the easy entry — it resolves a JDK 21+ for you (so it
works even when your default `java` is older), loads the gitignored `./.env`, and
dispatches the faces:

```bash
./spectro repl        # terminal REPL      ./spectro web       # web UI → :8080
./spectro run -p "…"  # headless run       ./spectro desktop   # Electron desktop app
./spectro doctor      # environment check  ./spectro tour      # guided feature tour
```

It also knows `cron` (scheduler), `sessions` (list stored runs), `resume <id>`,
and `mcp-notes` (build the bundled MCP example server). Raw Gradle still works
if you prefer (needs a JDK 21+ as `JAVA_HOME`):

```bash
./gradlew build                                # everything + all tests
./gradlew :spectro-cli:run -q --console=plain    # the terminal face (REPL)
./gradlew :spectro-server:bootRun                # the web face → http://127.0.0.1:8080
(cd spectro-web && npm install && npm run build) # rebuild the UI into the server jar
```

Note: the web build writes into `spectro-server/src/main/resources/static/`,
where the committed bundle lives, so rebuilding it dirties tracked files by
design (one jar serves the UI). Web development wants Node 20+.

Headless and scheduling:

```bash
./gradlew :spectro-cli:run -q --console=plain --args="run -p 'Say OK.' --json"
./gradlew :spectro-cli:run -q --console=plain --args="cron list"
./gradlew :spectro-cli:run -q --console=plain --args="doctor"
```

## Modules

| Module | What it is |
|---|---|
| `spectro-core` | the agent loop, providers, tools, permission gate, sessions, tracing seam |
| `spectro-cli` | terminal face: REPL, headless runs, doctor, tour, scheduler |
| `spectro-server` | Spring Boot web face: WebSocket stream + REST, serves the built UI |
| `spectro-web` | the React UI (Vite): chat, spectrum, trace, graph, text, lab |
| `spectro-desktop` | Electron shell that spawns and supervises the server jar |
| `spectro-mcp-notes` | bundled example MCP server (notes search/add over stdio) |
| `spectro-orchestrator` | the fleet: lanes as full agents on a shared bus, one merged stream |

## What ships

| Feature | What it does |
|---|---|
| **Settings hierarchy** | `defaults < env (SPECTRO_*) < ~/.spectro/settings.json (user; config.json read beneath it) < <launch-dir>/.spectro/settings.json (deprecated) < <workspace>/.spectro/settings.json (project) < <workspace>/.spectro/settings.local.json (local, gitignored) < CLI flags` — env is the BASE, any settings file outranks it; `spectro doctor` names every shadowed `SPECTRO_*` var. The project file travels with the repo — team conventions become checked-in settings; absolute machine paths (a workspace pin, MCP command paths) belong in the user or local file instead. See [`.spectro/settings.json.example`](.spectro/settings.json.example) for the shape, and `GET`/`PUT /api/settings` for the read/write API. Workspace-supplied config is *executed*, not just read (`mcpServers` spawns processes, `hooks` runs shell commands, a permissive `autoApprove`/`permissionMode` can auto-allow gates) — review a foreign repo's `.spectro/` before pinning it as your workspace. |
| **Permission allowlist** | `"autoApprove": ["write_file", "run_command:git status*"]` in any settings layer. Matched requests skip the y/N question; the decision still lands in the stream as a `permission_decision` event (auditable). |
| **Slash commands** | Inside the REPL: `/help`, `/cost`, `/model`, `/sessions`, `/compact` (force a context compaction now), `/clear` (fresh agent + fresh session file), `/exit` — plus `/skills`, `/mcp`, `/voice`. |
| **`spectro doctor`** | Environment check: Java version, config layers, provider reachability (Anthropic key / Ollama version probe / OpenAI-compatible probe), sessions dir writable, `jobs.json` valid. |
| **Third provider** | `"provider": "openai"` — any OpenAI-compatible server (LM Studio, llama.cpp, vLLM) over SSE streaming with fragmented tool-call assembly. Same `LlmProvider` interface, zero changes to the agent loop. |
| **`Agent.compactNow()`** | The additive core hook behind `/compact`. |
| **Image generation** | `generate_image` tool behind its own `ImageProvider` port — Gemini (`gemini-2.5-flash-image`) or OpenAI (`gpt-image-1`), switchable live via the web UI dropdown or `"imageProvider"`/`SPECTRO_IMAGE_PROVIDER`. Images land content-addressed under `~/.spectro/images/`, the additive `image_generated` event feeds the gallery panel. Needs `GEMINI_API_KEY` or `OPENAI_API_KEY`. |
| **Skill engine** | `SKILL.md` packages under `~/.spectro/skills/` and `<project>/.spectro/skills/` (project wins). The catalog rides in the system prompt; bodies load on demand through the `use_skill` tool. Four examples ship in `.spectro/skills/`: `brainstorming`, `test-driven-development`, `verification`, `writing-plans`. `/skills` lists them. |
| **In-app provider switch** | The header connection chip is a picker: switch the LLM backend (anthropic / ollama / openai) and its model mid-session. A `SwitchableProvider` swaps the delegate behind the once-built agent, so the change applies on the next prompt with history intact — no new event type. See [docs/ARCHITECTURE.md §2](docs/ARCHITECTURE.md#2-the-provider-port-and-the-runtime-switch). |
| **Design switcher** | A settings drawer (gear) re-skins the whole UI between the three brand designs — spectro dark (espresso, default), spectro bright (paper), spectro white — via `[data-design]` token overrides, with togglable scroll + particle effects and draft→save/revert. See [docs/WEB-UI.md](docs/WEB-UI.md). |
| **Lab (step-through replay)** | The lab tab: functional chat + the Flow map + the JSONL strip, all rendering the same *stepped* state. Events queue behind a client-side dam; step through them one by one (or open the dam), live or on an archived replay. See [docs/WEB-UI.md](docs/WEB-UI.md). |
| **`./spectro` launcher** | One command per face (`repl`/`run`/`cron`/`sessions`/`resume`/`doctor`/`tour`/`web`/`desktop`/`mcp-notes`). Resolves a JDK 21+ automatically, loads `./.env` for every face, and (for `desktop`) builds the boot jar, stops any stale instance, and clears the Electron quarantine flag on first install. |
| **Real tools** | `edit_file` (exact-string replace, permission-gated), `grep` + `glob` (pure-Java sandboxed search, read-only, also granted to explore subagents), `web_fetch` (URL → readable text over an injectable HTTP seam, permission-gated). All sandboxed, never-throw, no new event type. |
| **Web search + JS browsing** | Tiered `web_search`: the Tavily API when `TAVILY_API_KEY` is set, else the keyless DuckDuckGo HTML fallback — the ACTIVE tier is named in the tool description, every result header and `spectro doctor` (a DuckDuckGo bot-check answers a readable error, never a silent empty list). `browse_page` renders JS pages through the SYSTEM Chrome headless (`--dump-dom` + virtual-time budget; argv exec, never a shell; `SPECTRO_CHROME` overrides discovery, honest hint when no browser exists). Both permission-gated network egress; `browse_page` is url-scoped in the allowlist like `web_fetch`. |
| **Resilient loop** | Transient retry on 429/5xx/IO via a `RetryingProvider` decorator (pre-first-event only, cancel-aware; `maxRetries` / `SPECTRO_MAX_RETRIES`, default 2). Anthropic prompt caching on system + tools + the last stable message (`promptCaching` / `SPECTRO_PROMPT_CACHING`, default on; cache tokens folded back into the compaction trigger). spectroscope owns retry (SDK `maxRetries(0)`). |
| **Agent plan** | Permission-free `update_plan` tool (main-agent only) publishes the additive `plan` event — a latest-wins TODO list surfaced in the RightPanel **Plan** tab (open / running … / done) and pretty-printed in the CLI. |
| **Tool hooks** | A `hooks` block in the settings hierarchy (whole-block merge like `mcpServers`): `pre_tool_use` runs before the permission gate and can BLOCK (exit ≠ 0 or `{"decision":"block"}` JSON); `post_tool_use` is advisory. Config-only, fail-open timeout, tool metadata via `SPECTRO_TOOL_NAME`/`_INPUT`/`_RESULT`. `spectro doctor` reports the count. |
| **"Always allow"** | The web permission dialog gains a session "always allow (session)" checkbox and a gated permanent option that appends a **prefix-scoped** rule (e.g. `run_command:git*`) into `.spectro/settings.json` — the same `autoApprove` list the CLI reads. `Allowlist` lives in `spectro-core`, shared by both faces. |
| **Fleet orchestrator** | `Spectro.panel()` runs several lanes as full core agents on a shared bus (`spectro-orchestrator`): stamped envelopes, causal chain, one merged event stream — the web UI's Spectrum tab folds the fleet into lanes. |

## Provider matrix

Switching lives in the settings hierarchy — quickest way, as long as no settings
file already configures a provider: three lines in the gitignored `./.env`
(`SPECTRO_PROVIDER=ollama`, `SPECTRO_MODEL=qwen3`,
`SPECTRO_BASE_URL=http://localhost:11434`). Env is the BASE and any settings
file outranks it — `spectro doctor` tells you if one of yours is currently
shadowed; flags still win over everything. See `.env.example`.

| provider | transport | needs | default model |
|---|---|---|---|
| `anthropic` | official SDK, SSE | `ANTHROPIC_API_KEY` | `claude-opus-4-8` |
| `ollama` | Spring `RestClient`, NDJSON + declarative `@GetExchange` probe | local Ollama | `qwen3` |
| `openai` | Spring `RestClient`, SSE (`data:` lines) | any compatible server (`OPENAI_API_KEY` optional) | the loaded local model |

## Tests

`./gradlew build` runs the whole Java suite — 548 tests at last count (core:
events round-trip, agent loop against fake providers, sessions/resume,
compaction, subagents incl. parallelism and timeout, scheduler, allowlist, all
three provider wire mappings against scripted local servers; server: REST + a
full WebSocket round-trip against an Ollama mock; orchestrator: envelopes,
panel, tracing seam). The web UI has its own suite: `cd spectro-web && npm
test` (vitest, 310 tests). None of them needs an API key — the one live
contract check self-skips unless `ANTHROPIC_API_KEY` is set.

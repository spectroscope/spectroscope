# spectroscope architecture dossier · generated SVG suite

Fifteen designed architecture diagrams covering the **full build** (`spectro/`),
in the ex-brand design language (dark ground: Ebony, warm greys,
a neutral grotesk; Sand as the editorial highlight; Coral strictly for
interaction, decision and live elements; spot pastels only as zone coding).

Every SVG is **generated, never hand-edited**: each `build_NN_*.py` is a
parametric, deterministic generator (same input, same output) that imports the
shared drawing kit `svg_common.py`. Rerun after changes:

```bash
cd spectro/docs/diagrams
for g in build_*.py; do python3 "$g"; done
# visual check (rsvg-convert or Chrome headless; never qlmanage):
rsvg-convert -z 1.5 -o /tmp/check.png 00-one-core-five-faces.svg
```

## Provenance

Content is **source-verified, not guessed**: every class name, wire string,
endpoint, constant and count below was read from the repository on
**2026-07-16** (branch `refactor-clean-code`). The stats were measured on the
same tree: `find ... | xargs wc -l` for LOC, Gradle test-result XML for the
JUnit count, a vitest run for the web count. Gate at verification time:
**348 JUnit + 244 vitest, 0 failures.**

## The suite

| # | file | what it shows |
|---|---|---|
| 00 | `00-one-core-five-faces.svg` | The big picture: the container-free core, the RunEvent stream as the one wire, the five faces, the provider and image ports, the disk. |
| 01 | `01-gradle-modules.svg` | The build: four JVM modules plus two JS toolchains, real dependency edges (including the server's Transcriber reuse of spectro-cli), version catalog. |
| 02 | `02-runevent-protocol.svg` | All 18 RunEvent records with exact wire type strings, additive events marked, the wire rules, and the JSONL session file anatomy incl. the TS-edition interop invariant. |
| 03 | `03-provider-port.svg` | The LlmProvider port and its sealed vocabulary, the wrapper chain Switchable/Retrying/Tracing, the three backends, the retry policy, the ImageProvider port, the config precedence. |
| 04 | `04-agent-loop.svg` | One turn as a four-lane swimlane: request build, streaming, pre_tool_use hook, allowlist and human gate, sandboxed execution, feedback loop, compaction, run end. |
| 05 | `05-tool-belt.svg` | All 19 tools grouped, each with its gate class (free, gated, gated + prefix rule), the sandbox rules, the tool contract, and the allowlist guardedField mapping. |
| 06 | `06-subagents-a2a.svg` | Delegation: SubagentManager limits, explore/worker roles, the dev-tool-to-skill table, and the A2A-lite lifecycle as a parent/child sequence. |
| 07 | `07-spectro-server.svg` | The web backend: the /ws frame vocabulary in both directions, all 12 REST endpoints with their guards, and SessionConnection's responsibilities. |
| 08 | `08-spectro-web.svg` | The browser face: the rAF-batched pure-reducer pipeline, the tabs as lenses, header/sidebar/stores, and the three-design token system. |
| 09 | `09-launcher-desktop.svg` | Runtime: the ./spectro command table and pre-flight (JDK resolve, .env), the nine-step Electron supervision sequence, the 12 doctor checks, the voice setup scripts. |
| 10 | `10-mcp-integration.svg` | MCP: config block, registry, at-most-once client, stdio and HTTP-SSE transports, the McpTool adapter, and the spectro-mcp-notes example server. |
| 11 | `11-code-inventory-treemap.svg` | Code inventory: area proportional to lines of source per module and package, tests as dashed tiles, measured counts in the footer. |
| 12 | `12-the-wall.svg` | The wall poster: people, faces, core, OS, disk and everything beyond the network boundary in one picture, with the stats panel. |
| 13 | `13-protocol-breakdown.svg` | Protocol breakdown, hop by hop: where SSE actually lives (cloud LLM APIs and optional MCP-HTTP only; Ollama is NDJSON), the in-process EventStream, WebSocket to the browser, JSONL on disk, JSON-RPC/stdio for MCP, and the A2A-lite conversation between agents (events, no network). |
| 14 | `14-orchestrator-fleet.svg` | The fleet: BusEnvelope (task / status / result under one correlation id), every lane a full core agent on its own virtual thread, and the one merged EventStream the Spectrum tab folds. |

## Shared visual language

The zone colors are identical across all thirteen diagrams (encoded once in
`svg_common.py`):

- **Ocean** outlines the core library, **Lilac** the faces, **Salmon** the
  model side and external services, **Moss** the disk.
- **Sand** is reserved for the event wire, additive-event markers and stat
  numbers; **Coral** appears only where a human decides, a run is cancelled,
  or the network boundary is crossed.
- Dashed strokes mean external processes, optional paths, or test code
  (treemap). Every diagram carries its own legend and a provenance line.

The brand assets (M monogram, diamond) are embedded as inline paths from the
design system's logo vectors; type renders with a Helvetica
fallback, so the SVGs stay self-contained.

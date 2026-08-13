# MCP sample configuration

`settings.json` in this directory is the project layer of the config hierarchy
(`defaults < env (SPECTRO_*) < ~/.spectro/settings.json < <project>/.spectro/settings.json
< settings.local.json < CLI flags`). It is gitignored here because its
`mcpServers` paths are absolute machine paths — copy
[`settings.json.example`](settings.json.example) to `settings.json` and adjust
the two paths. Besides the `permissionMode` / `autoApprove` allowlist it
carries an `mcpServers` block — the **same shape** Claude Desktop and Claude Code
use — pointing at the bundled example MCP server, `spectro-mcp-notes`.

## Make the "notes" server runnable

The `mcpServers.notes.command` points at the `application`-plugin launch script,
which is produced by `installDist`:

```bash
./spectro-app mcp-notes                          # or: ./gradlew :spectro-mcp-notes:installDist
```

That writes the launcher to:

```
spectro-mcp-notes/build/install/spectro-mcp-notes/bin/spectro-mcp-notes
```

which is exactly the `command` in `settings.json`. The single `args` entry is the
notes directory the server serves — here the seeded `spectro-mcp-notes/notes/`
directory, so `search_notes` returns something out of the box.

## Try it

```bash
./spectro-app repl        # or ./gradlew tour → [1] agent REPL
```

In the REPL:

- `/mcp` lists the connected servers and their tools
  (`mcp__notes__search_notes`, `mcp__notes__add_note`).
- `./spectro-app doctor` also reports each configured MCP server and its reachability.
- Ask: *"Search my notes for the deploy runbook."* → the model calls the
  permission-gated `mcp__notes__search_notes` tool. MCP tool calls surface as
  ordinary `tool_call` / `tool_result` events — no new event type, no JSONL
  format change. The web face registers the same tools per connection.

## Notes

- The paths in `settings.json` are **absolute** so the launcher and the notes
  directory resolve regardless of the current working directory. Adjust them if
  you move this checkout.
- Whole-block replacement: a `~/.spectro/config.json` `mcpServers` block is
  **replaced** wholesale by this project block (no deep per-server merge).
- MCP tools are a static tool source, connected once at startup and registered
  alongside the standard tools. They are independent of the in-app provider
  switch — switching the LLM backend mid-session keeps the same MCP tools.
- **Which faces mount them, and which do not.** The REPL and a web session
  mount every configured server; `spectro doctor` connects to each one only to
  report its reachability, and closes it again. The headless faces mount none:
  `spectro run`, a cron fire and a triggered fleet node share one runner, and it
  carries the nine standard tools and nothing else. A `doctor` line saying
  `reachable` therefore does not mean `spectro run` has that server's tools —
  measured on 2026-08-13, the REPL sent 23 tools to the provider and `spectro
  run` sent 9, from the same settings file. Whether headless should mount is an
  open owner decision; the three roads are in
  [`../docs/HEADLESS-MCP.md`](../docs/HEADLESS-MCP.md).

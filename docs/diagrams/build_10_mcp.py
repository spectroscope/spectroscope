#!/usr/bin/env python3
"""10 — MCP: external tools over a protocol, with zero new event types.

Source-verified against spectro-core/.../core/mcp/* and spectro-mcp-notes/ on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

NB = " "
CONFIG_SNIPPET = [
    '"mcpServers": {',
    NB * 2 + '"notes": {',
    NB * 4 + '"command": ".../bin/spectro-mcp-notes",',
    NB * 4 + '"args": ["~/.spectro/notes"]',
    NB * 2 + '}',
    '}',
]


def build():
    mk = C.Markers("mcp")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 10",
        "MCP: external tools, no new events.",
        "A container-free MCP client wraps every remote tool as an ordinary spectroscope Tool. Calls surface as plain "
        "tool_call / tool_result, so graph, trace and JSONL show them for free and the wire stays byte-identical.")
    b.append(head)

    top = y0 + 10
    col_w = 380
    gap = (W - 2 * PAD - 3 * col_w) / 2
    x1, x2, x3 = PAD, PAD + col_w + gap, PAD + 2 * (col_w + gap)

    # ---- col 1: config + registry -----------------------------------------
    b.append(C.card(x1, top, col_w, 210, "The config block", accent=C.ZONE_DISK))
    b.append(C.text(x1 + 16, top + 44, "<project>/.spectro/settings.json", 11.5, C.GREY_MID, mono=True))
    b.append(C.rect(x1 + 16, top + 56, col_w - 32, 118, C.EBONY, C.STROKE_SOFT, rx=6))
    for i, ln in enumerate(CONFIG_SNIPPET):
        b.append(C.text(x1 + 28, top + 76 + i * 17, ln, 11, C.GREY_LIGHT, mono=True))
    b.append(C.text(x1 + 16, top + 194, "Claude-Desktop shape · whole-block merge", 10.8, C.GREY_DIM, mono=True))

    ry = top + 210 + 24
    b.append(C.card(x1, ry, col_w, 190, "McpServerRegistry", accent=C.ZONE_CORE))
    reg = [
        "connects EAGERLY at agent build",
        "a broken server is skipped (logged),",
        "never takes the harness down",
        "wraps each remote tool as McpTool",
        "servers(): name, target, reachable,",
        "toolCount (doctor + /mcp use this)",
    ]
    for i, ln in enumerate(reg):
        b.append(C.text(x1 + 16, ry + 46 + i * 21, ln, 11.5, C.GREY_MID, mono=True))

    ty = ry + 190 + 24
    b.append(C.card(x1, ty, col_w, 176, "McpTool (the adapter)", accent=C.CORAL))
    mt = [
        "name: mcp__<server>__<tool>",
        "needsPermission() = true, always",
        "description + schema from tools/list",
        "(missing schema -> empty object)",
        "execute() delegates to client.call,",
        "errors return ERROR: ... (never throw)",
    ]
    for i, ln in enumerate(mt):
        b.append(C.text(x1 + 16, ty + 46 + i * 21, ln, 11.5, C.GREY_MID, mono=True))

    # ---- col 2: client + transports ----------------------------------------
    b.append(C.card(x2, top, col_w, 264, "McpClient (one per server)", accent=C.ZONE_CORE))
    cl = [
        "start(): initialize ->",
        "notifications/initialized ->",
        "tools/list (descriptors cached)",
        "",
        "call(): AT-MOST-ONCE semantics",
        "dead transport? reconnect ONCE,",
        "then issue the call exactly once;",
        "failure/timeout poisons the channel",
        "and returns ERROR: (a slow-but-",
        "successful call is never doubled)",
        "DEFAULT_TIMEOUT = 20 s",
    ]
    for i, ln in enumerate(cl):
        b.append(C.text(x2 + 16, top + 44 + i * 19, ln, 11.5, C.GREY_MID, mono=True))

    ty2 = top + 264 + 24
    b.append(C.card(x2, ty2, col_w, 168, "StdioTransport (primary)", accent=C.ZONE_EXT))
    st = [
        "spawns the server as a child process",
        "JSON-RPC 2.0, one line per message",
        "stderr -> spectro-mcp-<name>.log",
        "protocol 2024-11-05 · graceful",
        "destroy, then destroyForcibly",
    ]
    for i, ln in enumerate(st):
        b.append(C.text(x2 + 16, ty2 + 46 + i * 22, ln, 11.5, C.GREY_MID, mono=True))

    ty3 = ty2 + 168 + 24
    b.append(C.card(x2, ty3, col_w, 128, "HttpSseTransport (optional)", accent=C.ZONE_EXT, dash="6 4"))
    ht = [
        "JSON-RPC over HTTP POST, reply read",
        "from a text/event-stream body",
        "RestClient · 20 s timeouts · stateless",
    ]
    for i, ln in enumerate(ht):
        b.append(C.text(x2 + 16, ty3 + 46 + i * 22, ln, 11.5, C.GREY_MID, mono=True))

    # arrows between columns
    b.append(C.arrow(mk, x1 + col_w, top + 100, x2 - 8, top + 100, C.ZONE_DISK))
    b.append(C.label_pill((x1 + col_w + x2) / 2, top + 84, "load(servers, cwd)"))
    b.append(C.arrow(mk, x2 + col_w, ty2 + 80, x3 - 8, ty2 + 80, C.ZONE_EXT))
    b.append(C.label_pill((x2 + col_w + x3) / 2, ty2 + 64, "stdin/stdout"))

    # ---- col 3: the example server ------------------------------------------
    b.append(C.card(x3, top, col_w, 420, "spectro-mcp-notes (the example)", accent=C.ZONE_EXT_DEEP))
    ns = [
        "NotesServer: stdio JSON-RPC 2.0,",
        "plain Jackson, no MCP SDK, no Lucene",
        "",
        "methods: initialize · tools/list ·",
        "tools/call · notifications/initialized",
        "",
        "search_notes(query, limit=5)",
        "  Ranker: term frequency +",
        "  substring bonus 2.0, top-N",
        "add_note(text)",
        "  note-%04d-%08x.txt, collision-safe",
        "",
        "storage: ~/.spectro/notes,",
        "one file per note · 6 seed notes",
        "",
        "build: ./spectro mcp-notes",
        "(-> build/install/.../bin/spectro-mcp-notes)",
    ]
    for i, ln in enumerate(ns):
        b.append(C.text(x3 + 16, top + 44 + i * 21, ln, 11.5, C.GREY_MID, mono=True))

    iy = top + 420 + 24
    b.append(C.card(x3, iy, col_w, 156, "The punchline", accent=C.SAND))
    pl = [
        "an MCP call in the stream is just",
        "tool_call  mcp__notes__search_notes",
        "tool_result  (ranked snippets)",
        "gated like any risky tool - the human",
        "sees it in chat, graph, Lab and trace",
        "with ZERO new event types",
    ]
    for i, ln in enumerate(pl):
        b.append(C.text(x3 + 16, iy + 44 + i * 19, ln, 11.5, C.GREY_MID, mono=True))

    bottom = max(ty + 176, ty3 + 128, iy + 156) + 40
    b.append(C.legend(PAD, bottom, [
        (C.ZONE_DISK, "config", "stroke"),
        (C.ZONE_CORE, "client core", "stroke"),
        (C.ZONE_EXT, "transport / external process", "stroke"),
        (C.CORAL, "permission-gated", "stroke"),
        (C.GREY_MID, "dashed = optional path", "dash"),
    ]))
    b.append(C.provenance(W, bottom, "build_10_mcp.py"))
    return C.doc(W, bottom + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "mcp")


if __name__ == "__main__":
    C.write("10-mcp-integration.svg", build())

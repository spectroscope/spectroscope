#!/usr/bin/env python3
"""13 - Protocol breakdown: which wire speaks what, hop by hop.

Answers three common confusions: where SSE actually lives (only between the
cloud LLM APIs and the provider adapters), where JSON-lines live (three
different documents share the framing), and how agents talk to each other
(no network at all: events on one merged in-process stream).

Source-verified against AnthropicProvider/OllamaProvider/OpenAiCompatProvider,
EventStream, SessionStore, SpectroSocketHandler, StdioTransport/HttpSseTransport
and SubagentManager/MergedEventStream on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56


def chipline(b, x, y, label, color, sub=None):
    """A protocol chip on an arrow: pill + optional grey sub-line under it."""
    w = C.est_w(label, 11.5, True) + 16
    b.append(C.rect(x - w / 2, y - 10, w, 20, C.EBONY, color, rx=10, sw=1.2))
    b.append(C.text(x, y + 4, label, 11.5, C.GREY_LIGHT, anchor="middle", mono=True))
    if sub:
        b.append(C.text(x, y + 22, sub, 10, C.GREY_DIM, anchor="middle", mono=True))


def build():
    mk = C.Markers("protocols")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 13",
        "The protocols.",
        "Five wire shapes carry one event model. SSE lives only between the cloud LLM APIs and the provider "
        "adapters; inside the harness everything is an in-process stream, the browser gets WebSocket frames, "
        "the disk gets JSONL, and agents talk to each other through plain events.")
    b.append(head)

    # ================= section A: the hop map ==============================
    top = y0 + 26
    b.append(C.text(PAD, top - 8, "THE HOP MAP: EVERY TRANSPORT, END TO END", 12, C.GREY_MID, ls="0.12em"))

    # -- left: model side ---------------------------------------------------
    lx, lw = PAD, 300
    models = [
        ("Anthropic API", "api.anthropic.com (cloud)", "HTTPS + SSE", "official SDK consumes the stream"),
        ("OpenAI-compatible", "/v1/chat/completions", "HTTPS + SSE", "data: chunks ... data: [DONE]"),
        ("Ollama", "localhost:11434 (local)", "HTTP + NDJSON", "one JSON object per line, NO SSE"),
    ]
    my = top + 12
    model_mid = []
    for name, host, proto, note in models:
        b.append(C.card(lx, my, lw, 86, None, accent=C.ZONE_EXT))
        b.append(C.text(lx + 14, my + 24, name, 14, C.WHITE, 700))
        b.append(C.text(lx + 14, my + 42, host, 10.8, C.GREY_MID, mono=True))
        b.append(C.text(lx + 14, my + 60, note, 10.8, C.GREY_DIM, mono=True))
        model_mid.append((my + 43, proto))
        my += 98

    # -- provider adapters ----------------------------------------------------
    ax, aw = 520, 260
    ay, ah = top + 40, 226
    b.append(C.card(ax, ay, aw, ah, "Provider adapters", accent=C.ZONE_CORE))
    for i, ln in enumerate([
        "AnthropicProvider (SDK)", "OpenAiCompatProvider", "OllamaProvider (RestClient)",
        "", "each translates its wire", "into typed ProviderEvents;", "the SSE/NDJSON parsing", "ends HERE",
    ]):
        b.append(C.text(ax + 14, ay + 46 + i * 21, ln, 11.3, C.GREY_MID, mono=True))
    for (ymid, proto), dy in zip(model_mid, (-62, 0, 62)):
        b.append(C.path_arrow(mk, f"M{lx + lw} {ymid} C {lx + lw + 60} {ymid}, {ax - 70} {ay + ah / 2 + dy}, {ax - 6} {ay + ah / 2 + dy}", C.ZONE_EXT, sw=1.5))
        chipline(b, (lx + lw + ax) / 2, ymid - 16, proto, C.ZONE_EXT_DEEP)

    # -- agent loop -----------------------------------------------------------
    gx, gw = 900, 250
    gy, gh = top + 40, 226
    b.append(C.card(gx, gy, gw, gh, "Agent loop (spectro-core)", accent=C.ZONE_CORE))
    for i, ln in enumerate([
        "folds ProviderEvents +", "tool results into RunEvents", "",
        "EventStream: blocking", "Iterable<RunEvent> on an", "ArrayBlockingQueue(64),",
        "virtual threads, in-process", "(zero serialization)",
    ]):
        b.append(C.text(gx + 14, gy + 46 + i * 21, ln, 11.3, C.GREY_MID, mono=True))
    b.append(C.arrow(mk, ax + aw, ay + ah / 2, gx - 6, gy + gh / 2, C.ZONE_CORE, sw=1.6))
    chipline(b, (ax + aw + gx) / 2, ay + ah / 2 - 18, "typed ProviderEvents", C.ZONE_CORE_DEEP)

    # -- consumers fan-out ----------------------------------------------------
    cx, cw = 1310, W - PAD - 1310
    cons = [
        ("Disk: the session file", C.ZONE_DISK, [
            "~/.spectro/sessions/<id>.jsonl",
            "SessionStore.append: one event",
            "per line, append-only, crash-safe,",
            "byte-identical with the TS edition",
        ], "JSONL append"),
        ("Browser (spectro-web)", C.ZONE_FACE, [
            "SpectroSocketHandler /ws",
            "1 RunEvent JSON per frame, 16 MiB",
            "upstream: 6 client frame types",
            "(user_message, permission_response,",
            "abort, set_provider, set_thinking,",
            "set_image_provider)",
        ], "WebSocket /ws"),
        ("Terminal (spectro-cli)", C.ZONE_FACE, [
            "EventRenderer: same process,",
            "no wire at all",
            "spectro run --json: NDJSON on",
            "stdout for scripts",
        ], "in-process / NDJSON"),
    ]
    cy2 = top + 6
    for title, accent, lines, proto in cons:
        h = 36 + len(lines) * 16 + 12
        b.append(C.card(cx, cy2, cw, h, None, accent=accent))
        b.append(C.text(cx + 14, cy2 + 24, title, 13.5, C.WHITE, 700))
        for i, ln in enumerate(lines):
            b.append(C.text(cx + 14, cy2 + 44 + i * 16, ln, 10.5, C.GREY_MID, mono=True))
        mid_y = cy2 + h / 2
        b.append(C.path_arrow(mk, f"M{gx + gw} {gy + gh / 2} C {gx + gw + 50} {gy + gh / 2}, {cx - 60} {mid_y}, {cx - 6} {mid_y}", C.SAND, sw=1.8))
        chipline(b, cx - 78, mid_y - 14, proto, C.SAND_DEEP)
        cy2 += h + 16
    b.append(C.text(gx + gw + 24, top + 2, "the RunEvent stream fans out", 11, C.SAND, mono=True))

    # -- MCP lane (below the hop map) -----------------------------------------
    mcp_y = max(my, ay + ah, cy2) + 8
    b.append(C.card(PAD, mcp_y, 760, 96, "MCP side channel (tools, not events)", accent=C.ZONE_EXT, dash="6 4"))
    for i, ln in enumerate([
        "McpClient <-> server: JSON-RPC 2.0 over stdio, one message per line (protocol 2024-11-05)",
        "optional HttpSseTransport: JSON-RPC over HTTP POST, the RESPONSE arrives as an SSE body",
        "results surface as ordinary tool_call / tool_result events: nothing new on the wire",
    ]):
        b.append(C.text(PAD + 16, mcp_y + 42 + i * 18, ln, 10.8, C.GREY_MID, mono=True))

    # ================= section B: the two myth checks =======================
    by = mcp_y + 96 + 30
    col_w = (W - 2 * PAD - 28) / 2
    b.append(C.card(PAD, by, col_w, 190, "Where SSE actually lives", accent=C.ZONE_EXT))
    sse = [
        "1  cloud LLM APIs stream SSE: Anthropic (inside the",
        "   official SDK) and OpenAI-style endpoints",
        "2  optional: an MCP server over HTTP answers SSE",
        "x  Ollama does NOT: it streams NDJSON",
        "x  the agent NEVER sees SSE: adapters translate to",
        "   typed events before anything leaves the provider",
        "x  the browser does NOT get SSE: it gets WebSocket",
    ]
    for i, ln in enumerate(sse):
        color = C.GREY_MID if ln.startswith(("1", "2", " ")) else C.GREY_LIGHT
        b.append(C.text(PAD + 16, by + 44 + i * 19, ln, 11.3, color, mono=True))

    b.append(C.card(PAD + col_w + 28, by, col_w, 190, "Where JSON lines live (same framing, three documents)", accent=C.ZONE_DISK))
    jl = [
        "1  the session file: one RunEvent per line",
        "   (the storage format, shared with the TS edition)",
        "2  MCP stdio framing: one JSON-RPC message per line",
        "3  spectro run --json: NDJSON RunEvents on stdout",
        "",
        "   do not confuse the framing (JSON per line) with",
        "   the document type: three different vocabularies",
    ]
    for i, ln in enumerate(jl):
        b.append(C.text(PAD + col_w + 44, by + 44 + i * 19, ln, 11.3, C.GREY_MID, mono=True))

    # ================= section C: agent-to-agent ============================
    ay2 = by + 190 + 30
    b.append(C.card(PAD, ay2, W - 2 * PAD, 210, "How agents talk to each other (A2A-lite): no network, just events", accent=C.SAND))
    b.append(C.text(PAD + 16, ay2 + 46,
                    "a child is its own Agent loop in the SAME JVM (virtual thread); MergedEventStream = one queue, many producers, so the whole conversation lands in the JSONL and every face for free",
                    11.5, C.GREY_MID, mono=True))
    steps = [
        ("agent_spawn", "child appears (agentId, parentId, task)"),
        ("agent_message · task", "parent -> child · state=submitted"),
        ("tool_call / deltas", "child works, own agentId on every event"),
        ("agent_message · status", "child -> parent · report_status tool"),
        ("agent_message · result", "child -> parent · completed | failed"),
    ]
    sx = PAD + 16
    sy2 = ay2 + 76
    step_w = (W - 2 * PAD - 32 - 4 * 34) / 5
    for i, (name, sub) in enumerate(steps):
        x = sx + i * (step_w + 34)
        b.append(C.rect(x, sy2, step_w, 64, C.CARD_UP, C.SAND_DEEP, rx=9, sw=1.1))
        b.append(C.text(x + 10, sy2 + 24, name, 12, C.GREY_LIGHT, 700, mono=True))
        for j, ln in enumerate(C.wrap(sub, 9.8, step_w - 18, mono=True)[:2]):
            b.append(C.text(x + 10, sy2 + 41 + j * 13, ln, 9.8, C.GREY_MID, mono=True))
        if i < len(steps) - 1:
            b.append(C.arrow(mk, x + step_w + 4, sy2 + 32, x + step_w + 30, sy2 + 32, C.SAND, sw=1.6))
    b.append(C.text(PAD + 16, sy2 + 92,
                    "permission gates ride along: a child's permission_request goes to the SAME human broker; hooks apply to children too · additive events, wire stays byte-identical",
                    11, C.GREY_DIM, mono=True))

    # ================= legend + provenance ==================================
    ly = ay2 + 210 + 36
    b.append(C.legend(PAD, ly, [
        (C.ZONE_EXT_DEEP, "external wire (SSE / NDJSON / JSON-RPC)", "stroke"),
        (C.ZONE_CORE_DEEP, "in-process (no serialization)", "stroke"),
        (C.SAND, "the RunEvent stream", "fill"),
        (C.ZONE_DISK, "disk", "stroke"),
        (C.ZONE_FACE, "faces", "stroke"),
        (C.GREY_MID, "dashed = side channel", "dash"),
    ]))
    b.append(C.provenance(W, ly, "build_13_protocols.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "protocols")


if __name__ == "__main__":
    C.write("13-protocol-breakdown.svg", build())

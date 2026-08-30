#!/usr/bin/env python3
"""15 — Deployment: who runs where, on which port, over which wire.

A component + deployment view. Where the dossier (00) shows the parts, this
shows the RUNNING processes, the ports they bind, and the exact protocol on
every data connection: WebSocket and REST to the browser, SSE / HTTPS / NDJSON
to the model side, stdio + HTTP to MCP, TCP between fleet nodes and the hub.

Source-verified against spectro-server/, spectro-core/, spectro-web/,
spectro-desktop/, spectro-orchestrator/ and SpectroConfig on 2026-07-22.
"""

import svg_common as C

W = 1680
PAD = 56


def port(x, y, label):
    """An amber port badge — a live-endpoint pill."""
    return C.label_pill(x, y, label, size=12, color=C.CORAL, fill=C.CARD_UP)


def brandmark(x, y):
    """The spectral-lines glyph (the favicon motif): color only on the lines."""
    bars = [(0, C.BLOSSOM, 3, 22), (6, C.CORAL, 3, 22), (12, C.MOSS, 4, 22),
            (19, C.OCEAN, 3, 22), (24, C.GREY_DIM, 3, 22)]
    out = []
    for dx, col, w, h in bars:
        out.append(C.rect(x + dx, y, w, h, col, rx=1.5))
    return "".join(out)


def build():
    mk = C.Markers("deploy")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 15",
        "Every process, every wire.",
        "One core, several faces, one model side. This is the deployment: the "
        "processes that run, the ports they bind, and the exact protocol on "
        "every connection between them.")
    b.append(head)
    b.append(brandmark(W - PAD - 30, PAD - 14))

    top_y = y0 + 6

    # ============================================================ zones (x)
    #   wide gaps (120px) so the protocol labels never reach into a card.
    ent_x, ent_w = PAD, 280               # entry surfaces (left, ocean)
    run_x, run_w = 456, 560               # running JVM processes (center)
    ext_x = 1136                          # model side (right, amber)
    ext_w = W - PAD - ext_x

    # ---------------------------------------------------- entry surfaces
    #   ordered top->bottom to match their target: browser + desktop reach the
    #   server (top of the run zone), the terminal reaches the cli (bottom) —
    #   so no wire has to cross another.
    b.append(C.text(ent_x, top_y + 4, "WHERE YOU SIT", 12.5, C.GREY_MID, ls="0.14em"))
    ey = top_y + 18
    entries = [
        ("browser", "the cockpit", "chat · spectrum · trace · graph · lab"),
        ("desktop app", "spectro-desktop", "Electron · spawns the server, no Java needed"),
        ("terminal", "spectro-cli", "picocli · renders events to the tty"),
    ]
    EH = 92
    ent_mid = []
    for kind, name, sub in entries:
        b.append(C.card(ent_x, ey, ent_w, EH, None, accent=C.ZONE_FACE))
        b.append(C.text(ent_x + 18, ey + 27, name, 15.5, C.WHITE, 700))
        b.append(C.text(ent_x + ent_w - 16, ey + 25, kind, 11, C.GREY_MID, anchor="end"))
        for i, ln in enumerate(C.wrap(sub, 12, ent_w - 36)):
            b.append(C.text(ent_x + 18, ey + 50 + i * 16, ln, 12, C.GREY_MID))
        ent_mid.append(ey + EH / 2)
        ey += EH + 26

    # ---------------------------------------------------- running processes
    b.append(C.text(run_x, top_y + 4, "WHAT RUNS", 12.5, C.GREY_MID, ls="0.14em"))
    ry0 = top_y + 18

    # spectro-server — the big one, :8080
    srv_h = 250
    b.append(C.card(run_x, ry0, run_w, srv_h, None, fill=C.CARD_SOFT, stroke=C.ZONE_FACE_DEEP))
    b.append(C.text(run_x + 20, ry0 + 32, "spectro-server", 18, C.WHITE, 700))
    b.append(C.text(run_x + 172, ry0 + 32, "Spring Boot · one JVM", 12, C.GREY_MID))
    b.append(port(run_x + run_w - 62, ry0 + 27, ":8080"))
    # endpoints inside the server
    endp = [
        ("WebSocket  /ws", "the live RunEvent stream — 18 typed events, one wire", C.SAND),
        ("REST  /api/*", "sessions · config · models · fleet · settings · key", C.ZONE_FACE),
        ("static  /", "serves the built web UI from the jar", C.ZONE_FACE),
    ]
    iy = ry0 + 50
    for name, sub, col in endp:
        b.append(C.rect(run_x + 20, iy, run_w - 40, 42, C.CARD, C.STROKE, rx=8))
        b.append(f'<path d="M{run_x + 20:.1f} {iy + 8:.1f} v26" stroke="{col}" stroke-width="3"/>')
        b.append(C.text(run_x + 36, iy + 19, name, 13, C.GREY_LIGHT, mono=True))
        b.append(C.text(run_x + 36, iy + 35, sub, 11, C.GREY_MID))
        iy += 48
    # the core lives inside
    b.append(C.rect(run_x + 20, iy + 2, run_w - 40, 40, C.CARD_UP, C.ZONE_CORE_DEEP, rx=8))
    b.append(f'<path d="M{run_x + 20:.1f} {iy + 10:.1f} v24" stroke="{C.ZONE_CORE}" stroke-width="3"/>')
    b.append(C.text(run_x + 36, iy + 20, "spectro-core", 13.5, C.WHITE, 700, mono=True))
    b.append(C.text(run_x + 158, iy + 20, "the loop · emits the RunEvent stream · appends JSONL", 11, C.GREY_MID))
    srv_mid = ry0 + srv_h / 2

    # spectro-cli — small, no port
    cli_y = ry0 + srv_h + 24
    cli_h = 74
    b.append(C.card(run_x, cli_y, run_w, cli_h, None, stroke=C.ZONE_FACE_DEEP))
    b.append(C.text(run_x + 20, cli_y + 28, "spectro-cli", 16, C.WHITE, 700))
    b.append(C.text(run_x + 138, cli_y + 28, "the same spectro-core, in your terminal — no server, no port", 11.5, C.GREY_MID))
    b.append(C.text(run_x + 20, cli_y + 52, "spectro run · repl · cron · doctor · node", 11.5, C.GREY_DIM, mono=True))
    cli_mid = cli_y + cli_h / 2

    # ---------------------------------------------------- model side (ext)
    b.append(C.text(ext_x, top_y + 4, "THE MODEL SIDE", 12.5, C.GREY_MID, ls="0.14em"))
    xy = top_y + 18
    b.append(C.card(ext_x, xy, ext_w, 258, "LlmProvider.stream()", accent=C.ZONE_EXT))
    b.append(C.text(ext_x + 16, xy + 46, "one port, three transports:", 11.5, C.GREY_MID))
    llm = [
        ("Anthropic", "api.anthropic.com", "HTTPS · SDK · SSE"),
        ("Ollama", "localhost:11434", "HTTP · NDJSON · key-free"),
        # SpectroConfig.openAiCompatProviders(), all five of them.
        ("OpenAI-compat", "openai · lmstudio · llamacpp · openrouter · gemini",
         "SSE · POST /chat/completions"),
    ]
    ly = xy + 58
    for name, host, proto in llm:
        b.append(C.rect(ext_x + 16, ly, ext_w - 32, 56, C.CARD_UP, C.STROKE, rx=8))
        b.append(C.text(ext_x + 28, ly + 21, name, 13.5, C.GREY_LIGHT, 700))
        b.append(C.text(ext_x + 28, ly + 38, host, 11, C.CORAL, mono=True))
        b.append(C.text(ext_x + ext_w - 28, ly + 21, proto, 10.5, C.GREY_MID, mono=True, anchor="end"))
        ly += 64
    # the openai-compat hosts, small print — one per id in the row above, in
    # the same order, and no count in this comment: it said four over five.
    b.append(C.text(ext_x + 16, ly + 6, "api.openai.com · :1234 · :8080 · openrouter.ai/api · …/v1beta/openai", 10, C.GREY_DIM, mono=True))

    # image + mcp
    iy2 = xy + 258 + 20
    b.append(C.card(ext_x, iy2, ext_w, 74, "ImageProvider.generate()", accent=C.ZONE_EXT))
    b.append(C.text(ext_x + 16, iy2 + 46, "Gemini · OpenAI images", 12, C.GREY_MID))
    b.append(C.text(ext_x + ext_w - 16, iy2 + 46, "HTTPS", 11, C.GREY_DIM, mono=True, anchor="end"))
    my2 = iy2 + 74 + 20
    b.append(C.card(ext_x, my2, ext_w, 74, "MCP servers", accent=C.ZONE_EXT, dash="6 4"))
    b.append(C.text(ext_x + 16, my2 + 46, "external tools, spoken as ordinary tools", 12, C.GREY_MID))
    b.append(C.text(ext_x + ext_w - 16, my2 + 46, "stdio · HTTP+SSE", 11, C.GREY_DIM, mono=True, anchor="end"))

    # ============================================================ wiring
    gap_l = (ent_x + ent_w + run_x) / 2   # left gap midpoint — labels live here
    # browser <-> server : the live stream down to the browser, requests up
    b.append(C.arrow(mk, run_x - 6, srv_mid - 34, ent_x + ent_w + 6, ent_mid[0] - 6, C.SAND, sw=2.2))
    b.append(C.label_pill(gap_l, srv_mid - 52, "WebSocket /ws", 10, color=C.SAND))
    b.append(C.arrow(mk, ent_x + ent_w + 6, ent_mid[0] + 14, run_x - 6, srv_mid - 8, C.ZONE_FACE, sw=1.6))
    b.append(C.label_pill(gap_l, srv_mid + 2, "REST /api", 10, color=C.ZONE_FACE))
    # desktop -> server : spawns + supervises the jar (dynamic free port)
    b.append(C.arrow(mk, ent_x + ent_w + 6, ent_mid[1], run_x - 6, srv_mid + 42, C.ZONE_FACE, sw=1.6))
    b.append(C.label_pill(gap_l, srv_mid + 48, "spawns the jar", 10))
    # cli -> terminal : same process, events rendered to the tty
    b.append(C.arrow(mk, run_x - 6, cli_mid, ent_x + ent_w + 6, ent_mid[2], C.ZONE_FACE, sw=1.6))
    b.append(C.label_pill(gap_l, (cli_mid + ent_mid[2]) / 2 - 11, "renders to tty", 10))

    # core -> model side : the provider wires
    gap_r = (run_x + run_w + ext_x) / 2
    b.append(C.arrow(mk, run_x + run_w + 6, srv_mid, ext_x - 6, xy + 132, C.ZONE_EXT, sw=2.2))
    b.append(C.label_pill(gap_r, xy + 118, "LlmProvider · SSE", 10, color=C.CORAL))
    b.append(C.arrow(mk, run_x + run_w + 6, srv_mid + 42, ext_x - 6, iy2 + 37, C.ZONE_EXT, sw=1.5))
    b.append(C.label_pill(gap_r, iy2 + 22, "ImageProvider", 10, color=C.CORAL))
    b.append(C.arrow(mk, run_x + run_w + 6, srv_mid + 66, ext_x - 6, my2 + 37, C.ZONE_EXT, sw=1.5, dash="5 4"))
    b.append(C.label_pill(gap_r, my2 + 22, "McpTransport", 10))

    # ============================================================ fleet band
    fb_y = max(cli_y + cli_h, my2 + 74) + 34
    fb_h = 138
    b.append(C.card(PAD, fb_y, W - 2 * PAD, fb_h,
                    "Fleet: many agents, watched as one", accent=C.SAND))
    b.append(C.text(PAD + 16, fb_y + 47, "Spectro.panel() runs lanes in one JVM; spectro node runs them as OS processes.", 12.5, C.GREY_MID))
    # node cards -> hub -> server
    nx = PAD + 16
    ny = fb_y + 66
    NODE_W = 104
    for i in range(3):
        x = nx + i * 116
        b.append(C.rect(x, ny, NODE_W, 46, C.CARD_UP, C.STROKE, rx=8))
        b.append(C.text(x + NODE_W / 2, ny + 20, "spectro node", 10.5, C.GREY_LIGHT, anchor="middle", mono=True))
        b.append(C.text(x + NODE_W / 2, ny + 36, "a full agent", 10, C.GREY_DIM, anchor="middle"))
    nodes_r = nx + 2 * 116 + NODE_W
    hub_x = nodes_r + 120
    b.append(C.rect(hub_x, ny - 5, 200, 56, C.CARD, C.SAND_DEEP, rx=8))
    b.append(C.text(hub_x + 16, ny + 18, "ProcessBusHub", 13, C.WHITE, 700, mono=True))
    b.append(C.text(hub_x + 16, ny + 37, "loopback · at-least-once · replay", 10, C.GREY_MID))
    b.append(port(hub_x + 200 - 40, ny - 9, "TCP"))
    b.append(C.arrow(mk, nodes_r + 6, ny + 22, hub_x - 6, ny + 22, C.SAND, sw=1.8))
    b.append(C.label_pill((nodes_r + hub_x) / 2, ny + 8, "ProcessBus", 10, color=C.SAND))
    # hub -> server (aggregate)
    agg_x = hub_x + 200 + 120
    b.append(C.rect(agg_x, ny - 5, 252, 56, C.CARD, C.ZONE_FACE_DEEP, rx=8))
    b.append(C.text(agg_x + 16, ny + 18, "server aggregator", 13, C.WHITE, 700))
    b.append(C.text(agg_x + 16, ny + 37, "GET /api/fleet · /ws frames", 10, C.GREY_MID, mono=True))
    b.append(C.arrow(mk, hub_x + 200 + 6, ny + 22, agg_x - 6, ny + 22, C.ZONE_FACE, sw=1.8))
    b.append(C.label_pill((hub_x + 200 + agg_x) / 2, ny + 8, "merged", 10, color=C.ZONE_FACE))
    b.append(C.text(PAD + 16, fb_y + fb_h - 14,
                    "opt-in: SPECTRO_HUB_PORT on the server binds the hub, --hub host:port on each node dials it — all loopback",
                    10.5, C.GREY_DIM, mono=True))

    # ============================================================ disk band
    st_y = fb_y + fb_h + 28
    st_h = 96
    b.append(C.card(PAD, st_y, W - 2 * PAD, st_h,
                    "Disk: local-first, everything the run persists", accent=C.ZONE_DISK))
    disk = ["~/.spectro/.env", "~/.spectro/config.json", "~/.spectro/sessions/<id>.jsonl",
            "sessions/<id>/blobs/<sha256>", "~/.spectro/images/<sha256>", "~/.spectro/jobs.json",
            "<project>/.spectro/settings.json", "SPECTRO.md"]
    s, _ = C.chip_row(PAD + 16, st_y + 46, disk, W - 2 * PAD - 32, C.GREY_LIGHT, 11.5,
                      fill=C.CARD_UP, stroke=C.ZONE_DISK_DEEP)
    b.append(s)

    # ---- one-line truth: it's all local ---------------------------------
    b.append(C.text(W / 2, st_y + st_h + 30,
                    "Everything binds 127.0.0.1 — local-first, no TLS by design. The model side is the only network the agent reaches out to.",
                    12.5, C.GREY_MID, anchor="middle"))

    # ============================================================ legend + provenance
    ly2 = st_y + st_h + 74
    b.append(C.line(PAD, ly2 - 26, W - PAD, ly2 - 26, C.STROKE_SOFT))
    b.append(C.legend(PAD, ly2, [
        (C.ZONE_FACE, "faces / surfaces", "stroke"),
        (C.ZONE_CORE_DEEP, "spectro-core", "stroke"),
        (C.ZONE_EXT, "model side / external", "stroke"),
        (C.SAND, "the event wire", "fill"),
        (C.CORAL, "port / live endpoint", "fill"),
        (C.GREY_MID, "dashed = external / out-of-process", "dash"),
    ]))
    b.append(C.provenance(W, ly2, "build_15_deployment.py"))
    return C.doc(W, ly2 + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "deploy")


if __name__ == "__main__":
    C.write("15-deployment.svg", build())

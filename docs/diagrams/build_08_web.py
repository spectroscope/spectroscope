#!/usr/bin/env python3
"""08 — spectro-web: one stream, one pure reducer, many lenses.

Source-verified against spectro-web/src (App.tsx, state/*, lab/*, graph/*,
scenario/*, import/*, i18n, markdown, workspace, components) on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56


def build():
    mk = C.Markers("web")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 08",
        "The browser face.",
        "Events arrive on one socket, are batched per animation frame and folded by one pure reducer. "
        "Every tab is a different reader of the same UiState, so live runs, archives, imports and scenarios all render identically.")
    b.append(head)

    top = y0 + 8
    # ---- pipeline band ---------------------------------------------------
    ph = 128
    b.append(C.card(PAD, top, W - 2 * PAD, ph, None, fill=C.CARD_SOFT, stroke=C.STROKE))
    b.append(C.text(PAD + 16, top + 26, "THE STATE PIPELINE", 12, C.GREY_MID, ls="0.12em"))
    steps = [
        ("/ws socket", "transport/ws.ts\nreconnect backoff 1s..15s"),
        ("rAF batch", "n deltas ->\n1 React render"),
        ("reduceAll (pure)", "state/reducer.ts\n55 unit tests"),
        ("UiState", "turns · cards · trace ·\nagents · plan · images"),
        ("liveEvents[]", "raw, for the graph"),
        ("stepper dam", "the Lab queue\n(step | flow)"),
    ]
    sw = (W - 2 * PAD - 60) / len(steps)
    sx = PAD + 24
    for i, (name, sub) in enumerate(steps):
        x = sx + i * sw
        b.append(C.rect(x, top + 42, sw - 26, 66, C.CARD_UP, C.SAND_DEEP if i == 2 else C.STROKE, rx=9))
        b.append(C.text(x + 12, top + 64, name, 13, C.WHITE, 700, mono=True))
        for j, ln in enumerate(sub.split("\n")):
            b.append(C.text(x + 12, top + 82 + j * 14, ln, 10, C.GREY_MID, mono=True))
        if i < len(steps) - 1:
            b.append(C.arrow(mk, x + sw - 24, top + 75, x + sw - 2, top + 75, C.SAND))
    b.append(C.text(PAD + 16, top + ph - 6,
                    "replay = the same reducer over stored/imported/compiled events; the app only picks which source the components read",
                    11, C.GREY_DIM, mono=True))

    # ---- tabs row ---------------------------------------------------------
    ty = top + ph + 26
    b.append(C.text(PAD, ty, "THE FOUR TABS (App.tsx)", 12, C.GREY_MID, ls="0.12em"))
    ty += 12
    tab_w = (W - 2 * PAD - 3 * 24) / 4
    tabs = [
        ("Chat", [
            "threads.ts nests subagent turns",
            "markdown answers (own safe parser)",
            "tool cards + gate chips",
            "composer: drag-drop images + mic",
            "right panel: Agenten · Plan ·",
            "System-Kontext · Dateien",
        ]),
        ("Graph", [
            "Flow: BPMN overview (buildOverview,",
            "split/join per subagent wave)",
            "Graph: dagre DAG + laneShifts",
            "replay scrubber + time-lapse",
            "right-click pans, click selects",
            "detail: timing + raw JSON",
        ]),
        ("Trace", [
            "wireshark view of every frame,",
            "BOTH directions (recordOutgoing)",
            "delta-t, filters, JsonTree",
            "token-highlighted summaries",
            "cap 5,000 entries",
            "badge shows the count",
        ]),
        ("Lab", [
            "Flow: React-Flow system map",
            "(petri marking folded underneath)",
            "stepper: Bloecke | Einzeln grain,",
            "Flow auto-play 60..2000 ms tempo,",
            "step back · JSONL strip + dam",
        ]),
    ]
    for i, (name, lines) in enumerate(tabs):
        x = PAD + i * (tab_w + 24)
        h = 44 + len(lines) * 18 + 10
        b.append(C.card(x, ty, tab_w, h, name, accent=C.ZONE_FACE))
        for j, ln in enumerate(lines):
            b.append(C.text(x + 16, ty + 48 + j * 18, ln, 10.8, C.GREY_MID, mono=True))
    ty += 44 + 6 * 18 + 10 + 26

    # ---- feature band: header + sidebar + stores --------------------------
    col_w = (W - 2 * PAD - 2 * 24) / 3
    cols = [PAD + i * (col_w + 24) for i in range(3)]
    feats = [
        ("Header", [
            "provider picker: anthropic | ollama | openai",
            "model dropdown from GET /api/models",
            "(ollama live, cloud curated, custom typable)",
            "Thinking toggle -> set_thinking",
            "DE | EN chrome toggle (i18n.ts, chrome only)",
            "design drawer · context ring · Stop",
        ]),
        ("Sidebar + sources", [
            "sessions from GET /api/sessions + Live row",
            "Szenarien: 7 compiled demos (scenario DSL",
            "-> RunEvents, bilingual, same replay path)",
            "Import: spectroscope JSONL + Claude Code transcripts",
            "(detect.ts + claudeCode.ts adapter,",
            "one-click store list from the server)",
        ]),
        ("Stores (useSyncExternalStore)", [
            "designPrefs: 3 designs, draft vs saved,",
            "FOUC guard · brand dust particles",
            "(spectro white stays deliberately still)",
            "layout: panel widths + collapse, persisted",
            "lang: de | en, stamps <html lang>",
            "stepper: the Lab dam (not persisted)",
        ]),
    ]
    for i, (name, lines) in enumerate(feats):
        x = cols[i]
        h = 44 + len(lines) * 18 + 10
        b.append(C.card(x, ty, col_w, h, name, accent=C.ZONE_FACE_DEEP))
        for j, ln in enumerate(lines):
            b.append(C.text(x + 16, ty + 48 + j * 18, ln, 10.8, C.GREY_MID, mono=True))
    ty += 44 + 6 * 18 + 10 + 26

    # ---- design strip ------------------------------------------------------
    b.append(C.card(PAD, ty, W - 2 * PAD, 92, "The design idea: a design is a token override set", accent=C.SAND))
    designs = ["spectro dark (espresso · amber)", "spectro bright (paper · logo blue)",
               "spectro white (minimal · one blue)"]
    s, _ = C.chip_row(PAD + 16, ty + 40, designs, W - 2 * PAD - 32, C.GREY_LIGHT, 11.5)
    b.append(s)
    b.append(C.text(PAD + 16, ty + 82,
                    "[data-design] flips one attribute; every rule reads var(--token), so the whole UI re-expresses instantly. Shaders read the resolved variables.",
                    11, C.GREY_DIM, mono=True))
    ty += 92 + 36

    b.append(C.legend(PAD, ty, [
        (C.SAND, "the one pure fold", "stroke"),
        (C.ZONE_FACE, "tabs (lenses)", "stroke"),
        (C.ZONE_FACE_DEEP, "chrome + stores", "stroke"),
    ]))
    b.append(C.provenance(W, ty, "build_08_web.py"))
    return C.doc(W, ty + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "web")


if __name__ == "__main__":
    C.write("08-spectro-web.svg", build())

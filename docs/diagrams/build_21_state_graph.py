#!/usr/bin/env python3
"""21 — The state graph: drawn first, lit second.

WHY THIS FIGURE EXISTS. Every other surface in spectroscope is built AFTER the
fact. The trace, the spectrum, the session `graph` tab — each one folds an event
stream that has already happened into a picture. The state graph is the one view
that runs the other way round: `compile()` freezes the topology before the first
token, the drawing is handed to the sink inside that call, and the run that
follows only lights it up.

WHAT THE GEOMETRY SAYS. Two lanes share one time axis, and the axis is the real
record order of a real file. On the upper lane the drawing assembles itself out
of the stream, node by node, so the frame and the light arrive together and
"has not happened yet" is indistinguishable from "is not in this graph". On the
lower lane the frame is complete in the very first column and never changes
again; only the light moves along it. The two lanes agree in exactly one place —
the last column — and that agreement, arriving four moments too late, is the
whole argument.

Below the lanes: one sink, two files. The lifecycle file takes the seven
lifecycle records and the values file takes the two state records, each refusing
the other's vocabulary, which is what lets a single consumer feed both. The
values file is drawn dashed because it is optional and its tier is off until a
caller names one in a visible line of its own source.

READ OFF (2026-08-12, branch main):
  spectro-core/.../core/graph/StateGraph.java         the compile() overloads
  spectro-core/.../core/graph/CompiledGraph.java      "the drawing is written
                                                       IMMEDIATELY, in this
                                                       constructor"
  spectro-core/.../core/graph/GraphArtifact.java      the seven accepted types
  spectro-core/.../core/graph/StateArtifact.java      + StateRecords.STATE_TYPES
  spectro-core/.../core/graph/StatePolicy.java        the four tiers, DEFAULT_ALLOW
  spectro-core/.../core/graph/ArtifactPaths.java      the suffix re-pointing rule
  spectro-web/src/stategraph/demo/simple-rag.graph.jsonl   the 13 records on the
                                                       axis, counted in the file
  spectro-web/src/stategraph/demo/crag-payload.graph.jsonl the reference run:
                                                       37 records, 5 of 14 edges
                                                       never walked, `web` never
                                                       entered

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import svg_common as C

W = 1680
PAD = 56

# ---------------------------------------------------------------- the glyph
# simple-rag: __start__ -> retrieve -> rerank -> generate -> __end__. Five
# nodes, four edges, and small enough to draw ten times without the page
# turning into a wall of boxes.
GP = 46                 # dot pitch
GR = 8                  # dot radius
GW = 4 * GP             # left dot centre to right dot centre

NODE_FILL = {"q": C.EBONY, "d": C.CARD, "l": C.CORAL}
NODE_STROKE = {"q": C.GREY_DIM, "d": C.ZONE_CORE, "l": C.CORAL}
NODE_SW = {"q": 1.4, "d": 2.0, "l": 2.0}
EDGE_PEN = {"q": (C.GREY_DIM, 1.4), "w": (C.ZONE_CORE, 2.2)}

# Per column: the moment on the axis, then each lane's state.
#   nodes: - absent · q in the drawing, never entered · l running · d done
#   edges: - absent · q in the drawing, not walked · w walked
MOMENTS = [
    ("record 1", "graph_topology", "compile() writes it"),
    ("record 4", "node_start", "retrieve"),
    ("record 7", "node_start", "rerank"),
    ("record 10", "node_start", "generate"),
    ("record 13", "graph_end", "the run is over"),
]

# The upper lane: a picture folded out of a stream. Nothing exists until an
# event names it, so the frame grows at exactly the speed of the run.
LANE_FOLDED = [
    ("-----", "----", None, "nothing to fold yet"),
    ("ql---", "w---", "retrieve", "two nodes known"),
    ("qdl--", "ww--", "rerank", "three nodes known"),
    ("qddl-", "www-", "generate", "four nodes known"),
    ("qdddq", "wwww", None, "the same picture, at last"),
]

# The lower lane: the drawing is record 1. Every later column changes the
# light and nothing else.
LANE_COMPILED = [
    ("qqqqq", "qqqq", None, "0 of 3 entered"),
    ("qlqqq", "wqqq", "retrieve", "1 of 3 entered"),
    ("qdlqq", "wwqq", "rerank", "2 of 3 entered"),
    ("qddlq", "wwwq", "generate", "3 of 3 entered"),
    ("qdddq", "wwww", None, "3 of 3 done"),
]

LIFECYCLE_TYPES = ["graph_topology", "graph_start", "node_start", "node_end",
                   "node_error", "edge_taken", "graph_end"]
STATE_TYPES = ["state_policy", "state_payload"]
DEFAULT_ALLOW = ["question", "query_used", "route", "answer", "citations",
                 "confidence", "abstained", "grade_ratio", "rewrites", "trace"]

TIERS = [
    ("off", "the default — nothing recorded, nothing built", C.GREY_MID),
    ("summary", "the ten named channels only, and no documents", C.ZONE_CORE),
    ("sample", "everything not denied, cut to the caps", C.ZONE_FACE),
    ("full(true)", "everything not denied, uncapped; full(false) throws", C.CORAL),
]


def chain(cx, cy, nodes, edges, live=None):
    """One mini drawing at one moment. Edges first, so a dot always wins."""
    x0 = cx - GW / 2
    out = []
    for i, code in enumerate(edges):
        if code == "-":
            continue
        col, sw = EDGE_PEN[code]
        out.append(C.line(x0 + i * GP + GR + 3, cy,
                          x0 + (i + 1) * GP - GR - 3, cy, col, sw))
    for i, code in enumerate(nodes):
        if code == "-":
            continue
        out.append(C.circle(x0 + i * GP, cy, GR, NODE_FILL[code],
                            NODE_STROKE[code], NODE_SW[code]))
    if live is not None:
        i = nodes.index("l")
        out.append(C.text(x0 + i * GP, cy - 20, live, 10.5, C.CORAL,
                          anchor="middle", mono=True))
    return "".join(out)


def lane(b, x, y, w, h, accent, title, lines, columns, centres, tail=None):
    """One timeline: a label block on the left, five glyphs on the shared axis."""
    b.append(C.rect(x, y, w, h, C.CARD_SOFT, C.STROKE_SOFT, rx=12))
    b.append(f'<path d="M{x + 22:.1f} {y + 20:.1f} h44" '
             f'stroke="{accent}" stroke-width="3"/>')
    b.append(C.text(x + 22, y + 52, title, 19, C.WHITE, 640))
    ty = y + 78
    for ln in lines:
        b.append(C.text(x + 22, ty, ln, 12.5, C.GREY_MID))
        ty += 19
    if tail:
        b.append(C.text(x + 22, ty + 8, tail, 11, C.GREY_DIM, mono=True))
    cy = y + h / 2 + 6
    for (nodes, edges, live, caption), cx in zip(columns, centres):
        b.append(chain(cx, cy, nodes, edges, live))
        b.append(C.text(cx, cy + 34, caption, 11, C.GREY_LIGHT,
                        anchor="middle", mono=True))
    return cy


def file_card(b, x, y, w, name, sub, types, note, accent, dashed=False):
    """One of the two sibling files: what it takes, and what it refuses."""
    chips_w = w - 40
    rows, cw = 1, 0
    for t in types:                       # mirror chip_row's wrap arithmetic
        tw = C.est_w(t, 11.5, True) + 20
        if cw > 0 and cw + tw > chips_w:
            rows, cw = rows + 1, 0
        cw += tw + 8
    note_lines = C.wrap(note, 12, w - 44)
    h = 78 + rows * 32 + len(note_lines) * 18 + 8
    b.append(C.rect(x, y, w, h, C.CARD, C.GREY_DIM if dashed else C.STROKE, rx=12,
                    sw=1.2, dash="6 4" if dashed else None))
    b.append(f'<path d="M{x:.1f} {y + 12:.1f} v{h - 24:.1f}" '
             f'stroke="{accent}" stroke-width="3"/>')
    b.append(C.text(x + 20, y + 30, name, 15, C.WHITE, mono=True))
    b.append(C.text(x + 20, y + 50, sub, 12.5, C.GREY_MID))
    chips, _ = C.chip_row(x + 20, y + 62, types, chips_w, C.GREY_LIGHT, 11.5,
                          stroke=accent)
    b.append(chips)
    ny = y + 62 + rows * 32 + 12
    for ln in note_lines:
        b.append(C.text(x + 20, ny, ln, 12, C.GREY_MID))
        ny += 18
    return h


def build():
    mk = C.Markers("sg")
    b = []
    head, y0 = C.header(
        W, "the state graph", "drawn first, lit second",
        "Every other view in spectroscope is reconstructed after the fact from "
        "an event stream that has already happened. This one exists before the "
        "run: compile() freezes the topology, the drawing is handed over inside "
        "that call, and the stream that follows only lights it up.")
    b.append(head)

    # ===================================================== the two timelines
    y = y0 + 4
    b.append(C.text(PAD, y, "TWO WAYS TO GET A PICTURE OF ONE RUN  ·  "
                            "THE AXIS IS THE REAL RECORD ORDER OF simple-rag.graph.jsonl",
                    12, C.GREY_DIM, mono=True))
    y += 20

    lbl_w = 430
    tx0, tx1 = PAD + lbl_w + 24, W - PAD
    span = tx1 - tx0
    gwid = span / len(MOMENTS)
    centres = [tx0 + gwid / 2 + i * gwid for i in range(len(MOMENTS))]

    la_y, la_h = y, 188
    ax_y = la_y + la_h + 44
    lb_y, lb_h = ax_y + 44, 200

    lane(b, PAD, la_y, W - 2 * PAD, la_h, C.SAND, "folded from the stream", [
        "A view built by replaying what already happened. Before the run",
        "there is nothing to fold, and while it runs the frame and the light",
        "arrive together — so a node that has not fired yet and a node that",
        "is not in this graph look exactly the same.",
    ], LANE_FOLDED, centres)

    lane(b, PAD, lb_y, W - 2 * PAD, lb_h, C.ZONE_CORE, "written by compile()", [
        "The topology is validated, frozen and handed to the sink inside the",
        "compile() call, before a node has run — so the whole drawing is",
        "record 1. Nothing about the frame changes after that. Only the light",
        "moves along it, and an edge nobody walks stays on the canvas, dimmed.",
    ], LANE_COMPILED, centres,
        tail="__start__ → retrieve → rerank → generate → __end__")

    # ---- the shared axis: one file, read in order ------------------------
    b.append(C.line(tx0 - 18, ax_y, tx1, ax_y, C.SAND, 1.8))
    b.append(C.text(PAD + 22, ax_y - 8, "one file, read in order", 13, C.WHITE, 600))
    b.append(C.text(PAD + 22, ax_y + 14, "simple-rag.graph.jsonl · 13 records",
                    11.5, C.GREY_MID, mono=True))
    for (num, kind, why), cx in zip(MOMENTS, centres):
        b.append(C.line(cx, ax_y - 7, cx, ax_y + 7, C.SAND, 1.8))
        b.append(C.text(cx, ax_y - 16, num, 10.5, C.GREY_DIM,
                        anchor="middle", mono=True))
        b.append(C.text(cx, ax_y + 26, kind, 11.5, C.GREY_LIGHT,
                        anchor="middle", mono=True))
        b.append(C.text(cx, ax_y + 42, why, 10.5, C.GREY_DIM, anchor="middle"))

    # ---- the three things the lanes cannot say by themselves -------------
    y = lb_y + lb_h + 30
    for ln in [
        "The two lanes agree in exactly one column, the last. Everywhere before it they disagree, and the disagreement is not "
        "detail: only one of them is a drawing.",
        "The topology record is the only place an edge nobody walked exists. In the reference run — crag-payload, 37 records — "
        "five of the fourteen edges are never taken and the node web is never entered, and the view draws every one of them, "
        "dimmed, because they were known at compile().",
        "__start__ and __end__ sit in every drawing and are entered by no run: the walk crosses the edges to and from them "
        "without ever running a node, which is why the counter above says three and not five.",
    ]:
        for part in C.wrap(ln, 13, W - 2 * PAD):
            b.append(C.text(PAD, y, part, 13, C.GREY_MID))
            y += 20
        y += 6

    # ================================================= one sink, two files
    y += 16
    b.append(C.text(PAD, y, "ONE SINK, TWO FILES  ·  AND THE TIER THAT DECIDES "
                            "WHAT THE SECOND ONE IS ALLOWED TO HOLD",
                    12, C.GREY_DIM, mono=True))
    y += 22
    top = y

    ca_x, ca_w = PAD, 400
    cb_x, cb_w = 580, 546
    cc_x = 1150
    cc_w = W - PAD - cc_x

    # ---- the call --------------------------------------------------------
    code = [
        "try (GraphArtifact lifecycle = new GraphArtifact(stem);",
        "     StateArtifact values    = new StateArtifact(stem)) {",
        "    graph.compile(rec -> { lifecycle.accept(rec);",
        "                           values.accept(rec); },",
        "                  StatePolicy.summary());",
        "}",
    ]
    ca_note = ("A sink is any Consumer of a record map — that is the entire "
               "protocol, so an exporter stays a function. A fan-out to both "
               "files needs no class of its own, because each file refuses the "
               "other's vocabulary and the refusal IS the routing.")
    ca_lines = C.wrap(ca_note, 12, ca_w - 40)
    ca_h = 58 + len(code) * 17 + 14 + len(ca_lines) * 18 + 16
    b.append(C.card(ca_x, top, ca_w, ca_h, accent=C.ZONE_CORE))
    b.append(C.text(ca_x + 20, top + 30, "the call that draws it", 16, C.WHITE, 700))
    cy = top + 56
    for ln in code:
        # Drawn RAW rather than through C.text, for xml:space="preserve" alone:
        # the default collapses runs of spaces and strips leading ones, which
        # flattened this snippet's indentation to nothing and left the two
        # continuation lines reading as separate statements. NBSP is no fix —
        # librsvg trims a leading one too, U+00A0 being Unicode white space.
        b.append(f'<text x="{ca_x + 20:.1f}" y="{cy:.1f}" fill="{C.GREY_LIGHT}" '
                 f'font-size="10" font-weight="400" text-anchor="start" '
                 f'font-family="{C.MONO}" xml:space="preserve">'
                 f'{C.escape(ln)}</text>')
        cy += 17
    cy += 12
    for ln in ca_lines:
        b.append(C.text(ca_x + 20, cy, ln, 12, C.GREY_MID))
        cy += 18

    # ---- the two files ---------------------------------------------------
    h1 = file_card(b, cb_x, top, cb_w, "<stem>.graph.jsonl",
                   "the shape, and the light that walks it",
                   LIFECYCLE_TYPES,
                   "Seven record types and nothing else. A state record handed "
                   "to this writer is dropped and counted, so no wiring mistake "
                   "can put a document corpus in the file people attach to bug "
                   "reports.", C.ZONE_CORE)
    f2_y = top + h1 + 20
    h2 = file_card(b, cb_x, f2_y, cb_w, "<stem>.state.jsonl",
                   "what the nodes wrote — only when a tier is named",
                   STATE_TYPES,
                   "Two record types, and the mirror-image refusal: a lifecycle "
                   "record handed here is dropped too. It never clips, because "
                   "what arrives has already been through the policy.",
                   C.ZONE_FACE, dashed=True)

    # the fan-out: one consumer, two destinations
    src_x, src_y = ca_x + ca_w + 6, top + ca_h / 2
    for mid in (top + h1 / 2, f2_y + h2 / 2):
        mx = (src_x + cb_x) / 2
        b.append(C.path_arrow(
            mk, f"M{src_x:.1f} {src_y:.1f} C {mx:.1f} {src_y:.1f}, "
                f"{mx:.1f} {mid:.1f}, {cb_x - 8:.1f} {mid:.1f}",
            C.GREY_MID))
    # the label sits in the wedge BETWEEN the two curves, not on top of one
    b.append(C.label_pill((src_x + cb_x) / 2,
                          (top + h1 / 2 + f2_y + h2 / 2) / 2,
                          "one record map", 10))

    # ---- the four tiers --------------------------------------------------
    ty = top
    b.append(C.text(cc_x, ty + 14, "the tier is off until a caller names one",
                    13.5, C.WHITE, 600))
    ty += 34
    for name, why, accent in TIERS:
        b.append(C.rect(cc_x, ty, cc_w, 48, C.CARD, C.STROKE, rx=10, sw=1.2))
        b.append(f'<path d="M{cc_x:.1f} {ty + 10:.1f} v28" '
                 f'stroke="{accent}" stroke-width="3"/>')
        b.append(C.text(cc_x + 18, ty + 29, name, 13, C.GREY_LIGHT, mono=True))
        b.append(C.text(cc_x + 124, ty + 29, why, 12, C.GREY_MID))
        ty += 56
    ty += 20
    b.append(C.text(cc_x, ty, "what summary records, in reading order",
                    11.5, C.GREY_DIM, mono=True))
    chips, ty = C.chip_row(cc_x, ty + 10, DEFAULT_ALLOW, cc_w, C.GREY_LIGHT, 11,
                           stroke=C.ZONE_CORE)
    b.append(chips)
    ty += 26
    for ln in C.wrap("One stem, two files: a path that already carries a known "
                     "suffix is re-pointed rather than extended, so "
                     "state(run.graph.jsonl) lands on run.state.jsonl and never "
                     "on run.graph.state.jsonl.", 12, cc_w):
        b.append(C.text(cc_x, ty, ln, 12, C.GREY_MID))
        ty += 18

    y = max(top + ca_h, f2_y + h2, ty) + 34

    # ---- the view's own sentence ----------------------------------------
    b.append(C.text(PAD, y, "THE EMPTY VIEW SAYS IT ITSELF", 11, C.GREY_DIM,
                    mono=True, ls="0.14em"))
    y += 26
    b.append(C.text(PAD, y, "“The pair is <stem>.graph.jsonl for the shape and "
                            "<stem>.state.jsonl for the values. The shape alone "
                            "is enough; the values are optional.”",
                    15, C.GREY_LIGHT))
    y += 44

    b.append(C.line(PAD, y - 18, W - PAD, y - 18, C.STROKE_SOFT))
    b.append(C.legend(PAD, y + 6, [
        (C.ZONE_CORE, "walked · entered · done", "stroke"),
        (C.CORAL, "the node the run stands in", "fill"),
        (C.GREY_DIM, "in the drawing, never entered", "stroke"),
        (C.SAND, "the record stream", "fill"),
        (C.GREY_MID, "dashed = optional, off until asked for", "dash"),
    ]))
    b.append(C.provenance(W, y + 6, "build_21_state_graph.py"))
    return C.doc(W, y + 34, f"<defs>{mk.defs()}</defs>" + "".join(b),
                 "21-state-graph")


if __name__ == "__main__":
    C.write("21-state-graph.svg", build())

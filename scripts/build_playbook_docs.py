#!/usr/bin/env python3
"""Build the documentation page of a playbook folder.

Usage:

    python3 scripts/build_playbook_docs.py <playbook folder>

Reads <folder>/playbook.json (and LICENSE and PROVENANCE.md when present) and
writes <folder>/docs/index.html: one file, no network, light and dark through
prefers-color-scheme. The page holds an inline SVG of the graph, one section
per step, per decision and per document type, the models, the licence and the
provenance.

Layout of the graph: arrows that close a loop (found by a depth first walk
from the start) are "back" arrows; the rest form a DAG whose longest path gives
every node its column. Forward arrows are straight lines from the right edge of
the source to the left edge of the target. Back arrows run as a loop under the
row of their source, labelled with the outcome that takes them.

Stdlib only. No timestamps. The same inputs give byte identical output.
"""

import html
import json
import re
import sys
from pathlib import Path

STEP_W, STEP_H = 176, 68
DECISION_W, DECISION_H = 176, 92
END_W, END_H = 116, 40
COLUMN_GAP = 76
ROW_GAP = 52
LOOP_STEP = 22
MARGIN_X, MARGIN_Y = 32, 28

CHECK_LABELS = {
    "sections": ["pass", "fail"],
    "open_items": ["pass", "fail"],
    "command": ["pass", "fail"],
}

CSS = """\
:root {
  --bg: #fbfaf7;
  --panel: #ffffff;
  --fg: #1c1c1e;
  --muted: #5b5b61;
  --line: #8a8a92;
  --rule: #dcdad3;
  --step-fill: #eef3fb;
  --step-stroke: #3b6ea8;
  --decision-fill: #fdf3df;
  --decision-stroke: #a7701c;
  --end-fill: #e8f3ea;
  --end-stroke: #3f7d4f;
  --loop: #9c3d5e;
  --link: #1f5f9e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141517;
    --panel: #1d1f22;
    --fg: #ececee;
    --muted: #a3a3ab;
    --line: #7d7d86;
    --rule: #34363a;
    --step-fill: #1b2a3d;
    --step-stroke: #6fa3dc;
    --decision-fill: #3a2d14;
    --decision-stroke: #d9a14a;
    --end-fill: #1a3322;
    --end-stroke: #6dbb82;
    --loop: #e07a9d;
    --link: #8bbcf0;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  padding: 24px 16px 64px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 1.9rem; margin: 0 0 4px; }
h2 { font-size: 1.3rem; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--rule); }
h3 { font-size: 1.05rem; margin: 0 0 8px; }
p { margin: 0 0 12px; }
.lead { color: var(--muted); }
.note { color: var(--muted); font-size: 0.92rem; }
a { color: var(--link); }
nav ul { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; }
.figure {
  overflow-x: auto;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 8px;
}
.figure svg { display: block; max-width: none; }
.card {
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 14px 16px;
  margin: 0 0 12px;
}
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 12px 14px;
  font: 0.85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px; border-bottom: 1px solid var(--rule); }
th { color: var(--muted); font-weight: 600; }
.node-step { fill: var(--step-fill); stroke: var(--step-stroke); stroke-width: 1.5; }
.node-decision { fill: var(--decision-fill); stroke: var(--decision-stroke); stroke-width: 1.5; }
.node-end { fill: var(--end-fill); stroke: var(--end-stroke); stroke-width: 1.5; }
.arrow { fill: none; stroke: var(--line); stroke-width: 1.4; }
.loop { fill: none; stroke: var(--loop); stroke-width: 1.6; stroke-linejoin: round; }
.head { fill: var(--line); stroke: none; }
.head-loop { fill: var(--loop); stroke: none; }
.t-name { fill: var(--fg); stroke: none; font: 600 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
.t-sub { fill: var(--muted); stroke: none; font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
.t-edge { fill: var(--muted); stroke: var(--bg); stroke-width: 4px; paint-order: stroke; font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
.t-loop { fill: var(--loop); stroke: var(--bg); stroke-width: 4px; paint-order: stroke; font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (max-width: 560px) {
  dl { grid-template-columns: 1fr; gap: 0; }
  dt { margin-top: 6px; }
}
"""


def esc(value):
    return html.escape(str(value), quote=True)


def inline(text):
    """Escape, then turn `code` spans into <code>."""
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", esc(text))


# ---------------------------------------------------------------------------
# Graph layout


class Layout:
    def __init__(self, playbook):
        self.nodes = playbook.get("nodes", [])
        self.arrows = playbook.get("arrows", [])
        self.by_id = {n["id"]: n for n in self.nodes}
        self.order = {n["id"]: i for i, n in enumerate(self.nodes)}
        self.out = {n["id"]: [] for n in self.nodes}
        for index, arrow in enumerate(self.arrows):
            if arrow["from"] in self.out and arrow["to"] in self.by_id:
                self.out[arrow["from"]].append((index, arrow))
        self.back = set()
        self._find_back_arrows(playbook.get("start"))
        self._rank()
        self._rows(playbook.get("start"))
        self._place()

    # Depth first from the start; an arrow into a node on the stack closes a loop.
    def _find_back_arrows(self, start):
        state = {}
        roots = ([start] if start in self.by_id else []) + [n["id"] for n in self.nodes]

        def visit(node_id):
            state[node_id] = 1
            for index, arrow in self.out[node_id]:
                target = arrow["to"]
                if state.get(target) == 1:
                    self.back.add(index)
                elif target not in state:
                    visit(target)
            state[node_id] = 2

        for root in roots:
            if root not in state:
                visit(root)

    def forward(self, node_id):
        return [(i, a) for i, a in self.out[node_id] if i not in self.back]

    def _rank(self):
        parents = {n["id"]: [] for n in self.nodes}
        for node_id in self.out:
            for _, arrow in self.forward(node_id):
                parents[arrow["to"]].append(node_id)
        self.rank = {}

        def rank_of(node_id):
            if node_id not in self.rank:
                self.rank[node_id] = 0 if not parents[node_id] else 1 + max(rank_of(p) for p in parents[node_id])
            return self.rank[node_id]

        for n in self.nodes:
            rank_of(n["id"])
        self.height = {}

        def height_of(node_id):
            if node_id not in self.height:
                kids = [a["to"] for _, a in self.forward(node_id)]
                self.height[node_id] = 0 if not kids else 1 + max(height_of(k) for k in kids)
            return self.height[node_id]

        for n in self.nodes:
            height_of(n["id"])

    # The longest remaining path keeps the row of its parent; other branches open new rows.
    def _rows(self, start):
        self.row = {}
        counter = [0]

        def visit(node_id, row):
            if node_id in self.row:
                return
            self.row[node_id] = row
            kids = sorted(self.forward(node_id), key=lambda ia: (-self.height[ia[1]["to"]], ia[0]))
            first = True
            for _, arrow in kids:
                if first:
                    visit(arrow["to"], row)
                    first = False
                elif arrow["to"] not in self.row:
                    counter[0] += 1
                    visit(arrow["to"], counter[0])

        roots = ([start] if start in self.by_id else []) + [n["id"] for n in self.nodes]
        for root in roots:
            if root not in self.row:
                if root != start and self.row:
                    counter[0] += 1
                    visit(root, counter[0])
                else:
                    visit(root, 0)
        taken = {}
        for n in self.nodes:
            node_id = n["id"]
            row = self.row[node_id]
            while (self.rank[node_id], row) in taken:
                row += 1
            taken[(self.rank[node_id], row)] = node_id
            self.row[node_id] = row

    def size(self, node):
        kind = node["kind"]
        if kind == "decision":
            return DECISION_W, DECISION_H
        if kind == "end":
            return END_W, END_H
        return STEP_W, STEP_H

    def _place(self):
        row_count = max(self.row.values()) + 1 if self.row else 1
        column_count = max(self.rank.values()) + 1 if self.rank else 1
        row_h = [0] * row_count
        for n in self.nodes:
            row_h[self.row[n["id"]]] = max(row_h[self.row[n["id"]]], self.size(n)[1])
        column_pitch = STEP_W + COLUMN_GAP
        # One slot per loop under its source row; loops that do not overlap in x share a slot.
        loops_in_row = [0] * row_count
        self.loop_slot = {}
        self.loop_end_offset = {}
        by_row = {}
        for index in sorted(self.back):
            arrow = self.arrows[index]
            if arrow["from"] in self.by_id and arrow["to"] in self.by_id:
                by_row.setdefault(self.row[arrow["from"]], []).append(index)
        for source_row, indexes in by_row.items():
            spans = []
            for index in indexes:
                a, b = (self.rank[self.arrows[index]["from"]], self.rank[self.arrows[index]["to"]])
                spans.append((min(a, b), max(a, b), index))
            spans.sort()
            slot_ends = []
            for low, high, index in spans:
                for slot, end in enumerate(slot_ends):
                    if end < low:
                        slot_ends[slot] = high
                        self.loop_slot[index] = slot
                        break
                else:
                    slot_ends.append(high)
                    self.loop_slot[index] = len(slot_ends) - 1
            loops_in_row[source_row] = len(slot_ends)
        # Loops that share a source or a target are spread along the node edge.
        for key in ("from", "to"):
            groups = {}
            for index in sorted(self.back):
                arrow = self.arrows[index]
                groups.setdefault(arrow[key], []).append(index)
            for indexes in groups.values():
                for k, index in enumerate(indexes):
                    self.loop_end_offset[(index, key)] = (k - (len(indexes) - 1) / 2.0) * 14
        self.row_top = []
        y = MARGIN_Y
        for r in range(row_count):
            self.row_top.append(y)
            y += row_h[r] + ROW_GAP + LOOP_STEP * loops_in_row[r]
        self.row_h = row_h
        self.loops_in_row = loops_in_row
        self.pos = {}
        for n in self.nodes:
            w, h = self.size(n)
            cx = MARGIN_X + STEP_W / 2 + self.rank[n["id"]] * column_pitch
            cy = self.row_top[self.row[n["id"]]] + row_h[self.row[n["id"]]] / 2
            self.pos[n["id"]] = (cx, cy, w, h)
        self.width = int(MARGIN_X * 2 + STEP_W + (column_count - 1) * column_pitch)
        self.height_px = int(y - ROW_GAP + MARGIN_Y)


def wrap(text, limit):
    words = str(text).split()
    lines, current = [], ""
    for word in words:
        if current and len(current) + 1 + len(word) > limit:
            lines.append(current)
            current = word
        else:
            current = (current + " " + word).strip()
    if current:
        lines.append(current)
    return lines or [""]


def n(value):
    """Format a coordinate as a short, stable decimal."""
    text = "%.1f" % value
    return text[:-2] if text.endswith(".0") else text


def edge_bottom(node, pos, offset):
    cx, cy, w, h = pos
    if node["kind"] == "decision":
        return cx + offset, cy + (h / 2) * (1 - abs(offset) / (w / 2))
    return cx + offset, cy + h / 2


def node_label_lines(node, playbook):
    kind = node["kind"]
    name = node.get("name") or node["id"]
    if kind == "step":
        performer = node.get("performer", "chat")
        if node.get("role"):
            performer += " " + node["role"]
        bits = [performer, node.get("model", "")]
        sub = " · ".join(b for b in bits if b)
        if node.get("nod"):
            sub += " · nod"
        return wrap(name, 24)[:2], [sub]
    if kind == "decision":
        subs = []
        if node.get("max_rounds"):
            subs.append("up to %d rounds" % node["max_rounds"])
        return wrap(name, 14)[:2], subs
    return [name], [node.get("result", "")]


def draw_graph(layout, playbook):
    out = []
    out.append(
        '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="graph-title graph-desc" '
        'width="%d" height="%d" viewBox="0 0 %d %d">' % (layout.width, layout.height_px, layout.width, layout.height_px)
    )
    out.append('<title id="graph-title">%s graph</title>' % esc(playbook.get("name", "playbook")))
    out.append(
        '<desc id="graph-desc">Steps are rectangles, decisions are diamonds, ends are rounded boxes. '
        'Arrows run left to right; a coloured loop under a row leads back to an earlier node.</desc>'
    )
    out.append("<defs>")
    out.append(
        '<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
        '<path class="head" d="M0 0 L10 5 L0 10 z"/></marker>'
    )
    out.append(
        '<marker id="head-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
        '<path class="head-loop" d="M0 0 L10 5 L0 10 z"/></marker>'
    )
    out.append("</defs>")

    # Arrows first, nodes over them.
    forward_labels = []
    for index, arrow in enumerate(layout.arrows):
        if arrow["from"] not in layout.pos or arrow["to"] not in layout.pos or index in layout.back:
            continue
        sx, sy, sw, _ = layout.pos[arrow["from"]]
        tx, ty, tw, _ = layout.pos[arrow["to"]]
        x1, y1 = sx + sw / 2, sy
        x2, y2 = tx - tw / 2, ty
        out.append('<path class="arrow" d="M%s %s L%s %s" marker-end="url(#head)"/>' % (n(x1), n(y1), n(x2), n(y2)))
        if arrow.get("on"):
            forward_labels.append((x1 + (x2 - x1) * 0.18, y1 + (y2 - y1) * 0.18 - 6, arrow["on"]))

    # Loops: one slot per back arrow under the row of its source.
    loop_labels = []
    for index in sorted(layout.back):
        arrow = layout.arrows[index]
        if arrow["from"] not in layout.pos or arrow["to"] not in layout.pos:
            continue
        source = layout.by_id[arrow["from"]]
        target = layout.by_id[arrow["to"]]
        row = layout.row[arrow["from"]]
        slot = layout.loop_slot[index]
        sx, sy = edge_bottom(source, layout.pos[arrow["from"]], layout.loop_end_offset[(index, "from")])
        tx, ty = edge_bottom(target, layout.pos[arrow["to"]], layout.loop_end_offset[(index, "to")])
        loop_y = layout.row_top[row] + layout.row_h[row] + 22 + slot * LOOP_STEP
        out.append(
            '<path class="loop" d="M%s %s L%s %s L%s %s L%s %s" marker-end="url(#head-loop)"/>'
            % (n(sx), n(sy), n(sx), n(loop_y), n(tx), n(loop_y), n(tx), n(ty))
        )
        label = arrow.get("on", "")
        if source["kind"] == "decision" and source.get("max_rounds") and label:
            label += ", up to %d rounds" % source["max_rounds"]
        if label:
            loop_labels.append(((sx + tx) / 2, loop_y - 5, label))

    for node in layout.nodes:
        cx, cy, w, h = layout.pos[node["id"]]
        kind = node["kind"]
        title = esc(node.get("name") or node["id"])
        out.append('<g id="node-%s">' % esc(node["id"]))
        out.append("<title>%s</title>" % title)
        if kind == "decision":
            pts = [(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)]
            out.append('<polygon class="node-decision" points="%s"/>' % " ".join("%s,%s" % (n(x), n(y)) for x, y in pts))
        elif kind == "end":
            out.append(
                '<rect class="node-end" x="%s" y="%s" width="%d" height="%d" rx="%d"/>'
                % (n(cx - w / 2), n(cy - h / 2), w, h, h // 2)
            )
        else:
            out.append(
                '<rect class="node-step" x="%s" y="%s" width="%d" height="%d" rx="8"/>'
                % (n(cx - w / 2), n(cy - h / 2), w, h)
            )
        names, subs = node_label_lines(node, playbook)
        lines = [("t-name", t) for t in names] + [("t-sub", t) for t in subs]
        line_h = 16
        top = cy - (len(lines) * line_h) / 2 + 12
        for i, (cls, text) in enumerate(lines):
            out.append('<text class="%s" x="%s" y="%s" text-anchor="middle">%s</text>' % (cls, n(cx), n(top + i * line_h), esc(text)))
        out.append("</g>")

    for x, y, text in forward_labels:
        out.append('<text class="t-edge" x="%s" y="%s">%s</text>' % (n(x), n(y), esc(text)))
    for x, y, text in loop_labels:
        out.append('<text class="t-loop" x="%s" y="%s" text-anchor="middle">%s</text>' % (n(x), n(y), esc(text)))
    out.append("</svg>")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Sections


def model_text(playbook, key):
    models = playbook.get("models", {})
    if key not in models:
        return esc(key)
    primary = models[key].get("primary", {})
    text = "%s (%s %s" % (esc(key), esc(primary.get("provider", "")), esc(primary.get("model", "")))
    fallbacks = models[key].get("fallbacks", [])
    if fallbacks:
        text += ", then " + ", ".join(
            esc("%s %s" % (f.get("provider", ""), f.get("model", ""))) for f in fallbacks
        )
    return text + ")"


def doc_link(playbook, doc_id):
    documents = playbook.get("documents", {})
    if doc_id in documents:
        return '<a href="#document-%s">%s</a>' % (esc(doc_id), esc(documents[doc_id].get("name", doc_id)))
    return esc(doc_id)


def doc_list(playbook, ids):
    return ", ".join(doc_link(playbook, i) for i in ids) if ids else "none"


def node_name(layout, node_id):
    node = layout.by_id.get(node_id)
    return (node.get("name") or node_id) if node else node_id


def row(label, value_html):
    return "<dt>%s</dt><dd>%s</dd>" % (esc(label), value_html)


def step_section(layout, playbook, node):
    rows = []
    if node.get("goal"):
        rows.append(row("Goal", esc(node["goal"])))
    performer = node.get("performer", "chat")
    if node.get("role"):
        performer += ", role " + node["role"]
    rows.append(row("Performer", esc(performer)))
    rows.append(row("Model choice", model_text(playbook, node.get("model", ""))))
    rows.append(row("Privacy", esc(node.get("privacy", ""))))
    rows.append(row("Permission", esc(node.get("permission", ""))))
    skills = node.get("skills", [])
    rows.append(row("Skills", ", ".join("<code>%s</code>" % esc(s) for s in skills) if skills else "none"))
    rows.append(row("Consumes", doc_list(playbook, node.get("consumes", []))))
    rows.append(row("Produces", doc_list(playbook, node.get("produces", []))))
    rows.append(row("Nod", "asks for your approval before it moves on" if node.get("nod") else "none"))
    nexts = [a["to"] for _, a in layout.out[node["id"]]]
    rows.append(row("Next", ", ".join(esc(node_name(layout, t)) for t in nexts) if nexts else "none"))
    return '<section class="card" id="step-%s"><h3>%s</h3><dl>%s</dl></section>' % (
        esc(node["id"]), esc(node.get("name") or node["id"]), "".join(rows))


def outcomes_of(layout, playbook, node):
    if node.get("outcomes"):
        outcomes = list(node["outcomes"])
    else:
        check = playbook.get("checks", {}).get(node.get("check"), {})
        kind = check.get("kind")
        if kind in CHECK_LABELS:
            outcomes = list(CHECK_LABELS[kind])
        else:
            outcomes = list(check.get("labels", []))
    if node.get("max_rounds") and "exhausted" not in outcomes:
        outcomes.append("exhausted")
    if not outcomes:
        outcomes = [a.get("on", "") for _, a in layout.out[node["id"]]]
    return outcomes


def check_text(playbook, key):
    check = playbook.get("checks", {}).get(key)
    if not check:
        return esc(key)
    kind = check.get("kind", "")
    detail = ""
    if kind in ("sections", "open_items"):
        detail = "reads " + ", ".join(esc(d) for d in check.get("documents", []))
    elif kind == "command":
        detail = "runs <code>%s</code>" % esc(check.get("run", ""))
    elif kind == "review":
        detail = "model %s, reads %s" % (model_text(playbook, check.get("model", "")), ", ".join(esc(r) for r in check.get("reads", [])))
    elif kind == "human":
        detail = "asks “%s”" % esc(check.get("ask", ""))
    return "%s check: %s" % (esc(kind), detail) if detail else esc(kind)


def decision_section(layout, playbook, node):
    rows = [row("Check", check_text(playbook, node.get("check")))]
    outcomes = outcomes_of(layout, playbook, node)
    routes = {a.get("on", ""): a["to"] for _, a in layout.out[node["id"]]}
    parts = []
    for outcome in outcomes:
        target = routes.get(outcome)
        parts.append("%s to %s" % (esc(outcome), esc(node_name(layout, target)) if target else "nowhere"))
    rows.append(row("Outcomes", "<br>".join(parts)))
    if node.get("max_rounds"):
        rows.append(row("Ceiling", "up to %d rounds, then the outcome exhausted" % node["max_rounds"]))
    return '<section class="card" id="decision-%s"><h3>%s</h3><dl>%s</dl></section>' % (
        esc(node["id"]), esc(node.get("name") or node["id"]), "".join(rows))


def document_section(playbook, doc_id, doc):
    rows = [
        row("Purpose", esc(doc.get("purpose", ""))),
        row("Location", "<code>%s</code>" % esc(doc.get("location", ""))),
        row("Template", "<code>%s</code>" % esc(doc.get("template", ""))),
        row("Sections", ", ".join(esc(s) for s in doc.get("sections", [])) or "none"),
    ]
    return '<section class="card" id="document-%s"><h3>%s</h3><dl>%s</dl></section>' % (
        esc(doc_id), esc(doc.get("name", doc_id)), "".join(rows))


def models_table(playbook):
    lines = ["<table><thead><tr><th>Choice</th><th>Primary</th><th>Fallbacks</th></tr></thead><tbody>"]
    for key, model in playbook.get("models", {}).items():
        primary = model.get("primary", {})
        fallbacks = ", ".join(esc("%s %s" % (f.get("provider", ""), f.get("model", ""))) for f in model.get("fallbacks", []))
        lines.append("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            esc(key), esc("%s %s" % (primary.get("provider", ""), primary.get("model", ""))), fallbacks or "none"))
    lines.append("</tbody></table>")
    return "".join(lines)


def markdown(text):
    """A small renderer for the provenance file: headings, tables, bullets, paragraphs."""
    out = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("# "):
            i += 1
        elif line.startswith("## "):
            out.append("<h3>%s</h3>" % inline(line[3:]))
            i += 1
        elif line.startswith("|"):
            block = []
            while i < len(lines) and lines[i].startswith("|"):
                block.append(lines[i])
                i += 1
            cells = [[c.strip() for c in b.strip().strip("|").split("|")] for b in block]
            head, body = cells[0], [c for c in cells[2:]] if len(cells) > 1 else []
            table = ["<table><thead><tr>%s</tr></thead><tbody>" % "".join("<th>%s</th>" % inline(c) for c in head)]
            for r in body:
                table.append("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in r))
            table.append("</tbody></table>")
            out.append("".join(table))
        elif line.startswith("- "):
            items = []
            while i < len(lines) and lines[i].startswith("- "):
                items.append("<li>%s</li>" % inline(lines[i][2:]))
                i += 1
            out.append("<ul>%s</ul>" % "".join(items))
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "|", "- ")):
                para.append(lines[i])
                i += 1
            out.append("<p>%s</p>" % inline(" ".join(para)))
    return "\n".join(out)


def build_page(folder):
    playbook = json.loads((folder / "playbook.json").read_text(encoding="utf-8"))
    layout = Layout(playbook)
    name = playbook.get("name") or playbook.get("id", "playbook")
    steps = [x for x in layout.nodes if x["kind"] == "step"]
    decisions = [x for x in layout.nodes if x["kind"] == "decision"]
    documents = playbook.get("documents", {})
    parts = []
    parts.append("<!doctype html>")
    parts.append('<html lang="en">')
    parts.append("<head>")
    parts.append('<meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    parts.append("<title>%s</title>" % esc(name))
    parts.append("<style>\n%s</style>" % CSS)
    parts.append("</head>")
    parts.append("<body>")
    parts.append("<main>")
    parts.append("<header>")
    parts.append("<h1>%s</h1>" % esc(name))
    if playbook.get("description"):
        parts.append('<p class="lead">%s</p>' % esc(playbook["description"]))
    parts.append(
        '<p class="note">Schema version %s. This page describes the playbook. Runs do not follow the playbook yet.</p>'
        % esc(playbook.get("schema_version", ""))
    )
    parts.append(
        '<nav aria-label="Sections"><ul><li><a href="#graph">Graph</a></li><li><a href="#steps">Steps</a></li>'
        '<li><a href="#decisions">Decisions</a></li><li><a href="#documents">Documents</a></li>'
        '<li><a href="#models">Models</a></li><li><a href="#licence">Licence</a></li>'
        '<li><a href="#provenance">Provenance</a></li></ul></nav>'
    )
    parts.append("</header>")

    parts.append('<h2 id="graph">Graph</h2>')
    parts.append(
        '<p class="note">%d steps, %d decisions. Rectangles are steps, diamonds are decisions, rounded boxes are ends. '
        "A coloured loop under a row leads back, labelled with the outcome that takes it and the number of rounds it may run.</p>"
        % (len(steps), len(decisions))
    )
    parts.append('<div class="figure">%s</div>' % draw_graph(layout, playbook))

    parts.append('<h2 id="steps">Steps</h2>')
    parts.extend(step_section(layout, playbook, s) for s in steps)
    parts.append('<h2 id="decisions">Decisions</h2>')
    parts.extend(decision_section(layout, playbook, d) for d in decisions)
    parts.append('<h2 id="documents">Documents</h2>')
    parts.extend(document_section(playbook, k, v) for k, v in documents.items())
    parts.append('<h2 id="models">Models</h2>')
    parts.append(models_table(playbook))

    parts.append('<h2 id="licence">Licence</h2>')
    licence = folder / "LICENSE"
    if licence.is_file():
        parts.append("<pre>%s</pre>" % esc(licence.read_text(encoding="utf-8").strip()))
    else:
        parts.append("<p>No licence file in this folder.</p>")
    parts.append('<h2 id="provenance">Provenance</h2>')
    provenance = folder / "PROVENANCE.md"
    if provenance.is_file():
        parts.append(markdown(provenance.read_text(encoding="utf-8")))
    else:
        parts.append("<p>No provenance file in this folder.</p>")
    parts.append("</main>")
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts) + "\n"


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: build_playbook_docs.py <playbook folder>\n")
        return 2
    folder = Path(argv[1])
    if not (folder / "playbook.json").is_file():
        sys.stderr.write("no playbook.json in %s\n" % folder)
        return 2
    page = build_page(folder)
    target = folder / "docs" / "index.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(page)
    print("wrote %s (%d bytes)" % (target, len(page.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""20 — The feature map: what the product actually offers, on one page.

The dossier explains how the thing is built. This answers a different question,
the one a person asks before they care about architecture: what can it DO.

Grouped by the surface you would be looking at when you use it, not by module,
because the module map is diagram 01 and repeating it here would waste the page.
Everything listed is shipped in 0.3.0 and later; nothing here is planned work.

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import svg_common as C

W = 1680
PAD = 56

# (title, accent, subtitle, [features]) — the surfaces, in the order the tutorial
# opens them, which is also the order a new person meets them.
GROUPS = [
    ("the chat", C.ZONE_FACE, "ask, watch, interrupt", [
        "streaming answers with the model's thinking beside them",
        "queue a message while a run is still going",
        "stop a run at the wire, not at the next turn",
        "image input, push-to-talk voice in, spoken answers out",
        "disclosure levels: collapsed, everything open, thinking only",
    ]),
    ("the gate", C.CORAL, "decide what it may do", [
        "every write and every command asks first, by default",
        "allow once, allow for the session, or persist a rule",
        "ask / auto / readonly, switchable mid-session",
        "pre and post tool hooks around every call",
        "a workspace the file tools cannot escape",
    ]),
    ("the trace", C.LILAC, "read what happened", [
        "every event on the wire, in order, with timings",
        "the reasoning lens and the timeline lens",
        "replay any stored session, scrub it frame by frame",
        "an addressable frame: #/session/<id>@<n>",
        "import a session file from anywhere",
    ]),
    ("the prism", C.ZONE_CORE, "one run, many lines", [
        "subagents as their own lanes, spawned and merged",
        "the spectrum: token, tool, gate, subagent, lifecycle",
        "the lab: the run as a stepped flow map",
        "the graph: the causal shape of a run",
        "scenarios that replay without a provider at all",
    ]),
    ("the fleet", C.SALMON, "agents across processes", [
        "nodes over a TCP hub, reconnect with cursor resume",
        "one canvas for the whole fleet, aggregated or expanded",
        "the machine room: a fleet as one composed system",
        "answer a parked gate on a remote node",
        "spawn and stop nodes from the interface",
    ]),
    ("deep field", C.SAND, "point it outward", [
        "OTLP export to Langfuse, Jaeger, Phoenix",
        "MCP servers as tools, stdio or HTTP",
        "skills the agent loads by name",
        "an LLM reading of your own trace",
        "starter projects scaffolded in Java, Python or bash",
    ]),
]

FOOT = [
    "Seven backends: anthropic · openai · openrouter · gemini · ollama · LM Studio · llama.cpp, "
    "plus a built-in catalogue of local models that needs no key at all.",
    "Everything above writes one thing to disk: append-only JSONL, one line per event, readable with "
    "jq. That file is the API, the storage format and the audit log.",
]


def group(x, y, w, title, accent, subtitle, features):
    h = 62 + 26 * len(features)
    out = [C.card(x, y, w, h, accent=accent)]
    out.append(C.text(x + 22, y + 30, title, 19, C.WHITE, weight=600))
    out.append(C.text(x + 22, y + 49, subtitle, 12.5, accent))
    ty = y + 78
    for f in features:
        out.append(C.rect(x + 24, ty - 8, 5, 5, accent, rx=1))
        out.append(C.text(x + 38, ty, f, 13, C.GREY_LIGHT))
        ty += 26
    return "".join(out), h


def build():
    head, y = C.header(W, "the feature map", "what it does",
                       "every surface, and what you can do once you are on it")
    body = [head]
    y += 20

    col_w = (W - 2 * PAD - 28) / 2
    columns = [PAD, PAD + col_w + 28]
    tops = [y, y]
    for i, (title, accent, subtitle, features) in enumerate(GROUPS):
        col = i % 2
        chunk, h = group(columns[col], tops[col], col_w, title, accent, subtitle, features)
        body.append(chunk)
        tops[col] += h + 16

    y = max(tops) + 6
    for line in FOOT:
        for row in C.wrap(line, 13, W - 2 * PAD - 200):
            body.append(C.text(PAD, y, row, 13, C.GREY_MID))
            y += 21
        y += 10

    height = y + 44
    body.append(C.provenance(W, height - 22, "build_20_feature_map.py"))
    C.write("20-feature-map.svg", C.doc(W, height, "".join(body), "20-feature-map"))


if __name__ == "__main__":
    build()

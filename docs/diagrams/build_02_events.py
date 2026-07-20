#!/usr/bin/env python3
"""02 — The event protocol: all 18 RunEvent types and the JSONL wire.

Source-verified against spectro-core/src/main/java/spectro-core/.../core/events/RunEvent.java
and spectro-core/.../core/session/SessionStore.java on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

# (wire type, record, fields, additive)
GROUPS = [
    ("Lifecycle", C.ZONE_CORE_DEEP, [
        ("run_start", "RunStart", "runId agentId parentId prompt provider attachments", False),
        ("turn_start", "TurnStart", "agentId turn", False),
        ("run_end", "RunEnd", "runId stopReason", False),
        ("error", "ErrorEvent", "agentId message", False),
    ]),
    ("Streaming", C.SAND_DEEP, [
        ("text_delta", "TextDelta", "agentId text", False),
        ("thinking_delta", "ThinkingDelta", "agentId text", True),
    ]),
    ("Tool loop", C.ZONE_CORE_DEEP, [
        ("tool_call", "ToolCall", "agentId callId name input", False),
        ("tool_result", "ToolResult", "agentId callId output isError durationMs", False),
    ]),
    ("Permission gate", C.CRIMSON_DEEP, [
        ("permission_request", "PermissionRequest", "agentId callId name input", False),
        ("permission_decision", "PermissionDecision", "callId allowed", False),
    ]),
    ("Agent tree", C.ZONE_FACE_DEEP, [
        ("agent_spawn", "AgentSpawn", "agentId parentId task", False),
        ("agent_message", "AgentMessage", "from to role state text label", True),
    ]),
    ("Accounting", C.ZONE_DISK_DEEP, [
        ("usage", "Usage", "agentId inputTokens outputTokens", False),
        ("context_info", "ContextInfo", "agentId turn messages estimatedTokens threshold parts", True),
        ("compaction", "Compaction", "agentId removedTurns summaryChars", True),
    ]),
    ("Capabilities", C.ZONE_EXT_DEEP, [
        ("voice_input", "VoiceInput", "agentId durationMs model", True),
        ("image_generated", "ImageGenerated", "agentId callId prompt provider model mediaType blobPath sha256", True),
        ("plan", "Plan", "agentId steps[text status]", True),
    ]),
]

SAMPLE = ('{"type":"tool_call","agentId":"main","callId":"call-7",'
          '"name":"read_file","input":{"path":"src/App.tsx"},"ts":1783000012400}')


def event_card(b, x, y, w, wire, record, fields, additive, accent):
    h = 74
    b.append(C.rect(x, y, w, h, C.CARD, C.STROKE, rx=10))
    b.append(f'<path d="M{x:.1f} {y + 10:.1f} v{h - 20}" stroke="{accent}" stroke-width="3"/>')
    b.append(C.text(x + 14, y + 22, wire, 14, C.WHITE, 700, mono=True))
    b.append(C.text(x + 14 + C.est_w(wire, 14, True) + 10, y + 22, record, 11, C.GREY_DIM))
    if additive:
        b.append(C.diamond(x + w - 26, y + 10, 16, C.SAND))
        b.append(C.text(x + w - 32, y + 22, "additive", 10, C.SAND_DEEP if False else C.SAND, anchor="end"))
    lines = C.wrap(fields, 10.5, w - 26, mono=True)[:2]
    for i, ln in enumerate(lines):
        b.append(C.text(x + 14, y + 41 + i * 15, ln, 10.5, C.GREY_MID, mono=True))
    return h


def build():
    mk = C.Markers("events")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 02",
        "The event protocol.",
        "One sealed interface, 18 records, Jackson-typed by a snake_case \"type\" property. The same line "
        "is the socket frame, the JSONL storage row and the graph input.")
    b.append(head)

    # 3-column masonry of groups
    col_w = (W - 2 * PAD - 2 * 28) / 3
    col_x = [PAD + i * (col_w + 28) for i in range(3)]
    col_y = [y0 + 8] * 3
    order = [0, 1, 2, 0, 1, 2, 1]  # place groups round-robin-ish, capabilities mid
    for gi, (gname, accent, events) in enumerate(GROUPS):
        ci = order[gi]
        x, y = col_x[ci], col_y[ci]
        b.append(C.text(x, y + 12, gname.upper(), 12, C.GREY_MID, ls="0.12em"))
        y += 24
        for wire, rec, fields, add in events:
            h = event_card(b, x, y, col_w, wire, rec, fields, add, accent)
            y += h + 10
        col_y[ci] = y + 22

    grid_bottom = max(col_y)

    # wire rules band
    wy = grid_bottom + 6
    b.append(C.card(PAD, wy, W - 2 * PAD, 96, "Wire rules", accent=C.SAND))
    rules = ["@JsonTypeInfo(property = \"type\")", "snake_case type values", "camelCase field names",
             "@JsonInclude(NON_NULL)", "long ts on every event", "unknown types must be ignored (forward compat)"]
    s, _ = C.chip_row(PAD + 16, wy + 42, rules, W - 2 * PAD - 32, C.GREY_LIGHT, 12)
    b.append(s)

    # JSONL anatomy band
    jy = wy + 96 + 22
    b.append(C.card(PAD, jy, W - 2 * PAD, 170, "The JSONL session file", accent=C.ZONE_DISK))
    b.append(C.text(PAD + 16, jy + 48, "~/.spectro/sessions/<yyyyMMdd-HHmmss-uuid8>.jsonl · append one line per event, crash-safe, never rewritten (compaction is in-memory only)", 12.5, C.GREY_LIGHT))
    b.append(C.rect(PAD + 16, jy + 62, W - 2 * PAD - 32, 30, C.EBONY, C.STROKE_SOFT, rx=6))
    b.append(C.text(PAD + 28, jy + 82, SAMPLE, 11.5, C.GREY_LIGHT, mono=True))
    b.append(C.text(PAD + 16, jy + 116,
                    "resume: readSessionEvents drops a torn last line · loadSession finds the main agent structurally "
                    "(first run_start without parentId) · orphan tool_calls dropped · adjacent roles merged",
                    12, C.GREY_MID))
    b.append(C.text(PAD + 16, jy + 140,
                    "interop invariant: byte-identical with the TypeScript edition · proven by CrossEditionReplayTest + "
                    "JsonlFormatInteropTest against interop/ts-edition-session.jsonl",
                    12, C.GREY_MID))
    b.append(C.diamond(W - PAD - 60, jy + 24, 120, C.ZONE_DISK, 0.16))

    ly = jy + 170 + 40
    b.append(C.legend(PAD, ly, [
        (C.SAND, "additive event (safe extension)", "fill"),
        (C.ZONE_CORE_DEEP, "core protocol", "stroke"),
        (C.CRIMSON_DEEP, "gate", "stroke"),
        (C.ZONE_FACE_DEEP, "agent tree", "stroke"),
        (C.ZONE_DISK_DEEP, "accounting", "stroke"),
        (C.ZONE_EXT_DEEP, "capabilities", "stroke"),
    ]))
    b.append(C.provenance(W, ly, "build_02_events.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "events")


if __name__ == "__main__":
    C.write("02-runevent-protocol.svg", build())

#!/usr/bin/env python3
"""14 — The fleet: spectro-orchestrator, agents on a bus, one spectrum.

Source-verified against spectro-orchestrator/src/main/java/dev/spectroscope/
orchestrator/{OrchestratorPanel,BusEnvelope,BusTransport,InMemoryBus}.java
and dev/spectroscope/{Spectro,FleetPanel}.java on 2026-07-20.
"""

import svg_common as C

W = 1680
PAD = 56

CODE = [
    ('var panel = Spectro.panel().model(Anthropic.opus());', C.WHITE),
    ('panel.agent("bugs").task("Find bugs in the diff");', C.WHITE),
    ('panel.agent("perf").task("Check the hot queries");', C.WHITE),
    ("", C.WHITE),
    ("for (RunEvent event : panel.run()) {", C.WHITE),
    ("    System.out.println(event);  // every lane, one spectrum", C.GREY_MID),
    ("}", C.WHITE),
]

ENVELOPE = ["sender", "contextId", "taskId", "sequence", "parentId", "topic", "payload = RunEvent, verbatim"]

CHOREO = [
    ("agent_spawn", "the panel announces the lane", C.OCEAN),
    ("task / submitted", "the assignment, visible on the stream", C.SAND),
    ("status / working", "the lane reports in", C.OCEAN),
    ("run_start … run_end", "the lane's own events, forwarded verbatim", C.MOSS),
    ("result / completed | failed", "the recorded outcome", C.OCEAN),
    ("panel run_end", "the spectrum closes", C.GREY_MID),
]


def build():
    mk = C.Markers("orchestrator")
    b = []
    head, y0 = C.header(
        W, "spectro-orchestrator",
        "the fleet: agents on a bus, one spectrum",
        "Spectro.panel() runs every lane as a full core agent on its own virtual thread. "
        "Every event rides the bus as an envelope; ONE aggregator drains the fleet's topic "
        "into one EventStream — the same blocking for-loop as a single agent.")
    b.append(head)

    col_w = (W - 2 * PAD - 2 * 40) / 3
    x1, x2, x3 = PAD, PAD + col_w + 40, PAD + 2 * (col_w + 40)

    # ---- left: the frozen facade, fleet edition
    code_h = 40 + len(CODE) * 24 + 18
    b.append(C.card(x1, y0, col_w, code_h, "the five lines, fleet edition", accent=C.CORAL))
    cy = y0 + 58
    for line_s, fill in CODE:
        if line_s:
            b.append(C.text(x1 + 20, cy, line_s, 13.5, fill, mono=True))
        cy += 24

    # ---- middle: the lanes
    lane_h = 74
    lanes_title_y = y0
    b.append(C.card(x2, lanes_title_y, col_w, 3 * (lane_h + 14) + 56, "the lanes", accent=C.ZONE_CORE))
    ly = lanes_title_y + 44
    for lane, task in (("bugs", "Find bugs in the diff"),
                       ("perf", "Check the hot queries"),
                       ("security", "Review the input handling")):
        b.append(C.rect(x2 + 16, ly, col_w - 32, lane_h, C.CARD_UP, C.STROKE, rx=10))
        b.append(C.circle(x2 + 34, ly + 24, 4, C.ZONE_CORE))
        b.append(C.text(x2 + 46, ly + 29, lane, 14.5, C.WHITE, 700, mono=True))
        b.append(C.text(x2 + 46, ly + 50, task, 12.5, C.GREY_MID))
        pill = C.label_pill(x2 + col_w - 110, ly + 24, "core agent · one VT", 10.5, C.GREY_MID)
        b.append(pill)
        ly += lane_h + 14

    # ---- right: the aggregator
    agg_h = 3 * (lane_h + 14) + 56
    b.append(C.card(x3, y0, col_w, agg_h, "the aggregator", accent=C.ZONE_FACE))
    b.append(C.text(x3 + 20, y0 + 62, "ONE subscriber on the fleet's topic", 14, C.GREY_LIGHT))
    b.append(C.text(x3 + 20, y0 + 86, "unwraps envelopes, keeps arrival order", 13, C.GREY_MID))
    b.append(C.text(x3 + 20, y0 + 126, "EventStream", 15, C.WHITE, 700, mono=True))
    b.append(C.text(x3 + 20, y0 + 148, "blocking for-each · backpressure by design", 12.5, C.GREY_MID))
    b.append(C.line(x3 + 16, y0 + 170, x3 + col_w - 16, y0 + 170, C.STROKE_SOFT))
    b.append(C.text(x3 + 20, y0 + 198, "faces downstream:", 12.5, C.GREY_MID))
    chips, _ = C.chip_row(x3 + 20, y0 + 212, ["Spectrum tab", "JSONL session", "spectro explain"],
                          col_w - 40, C.GREY_LIGHT, 12)
    b.append(chips)

    # ---- arrows across the top row
    mid_y = y0 + code_h / 2
    b.append(C.arrow(mk, x1 + col_w, y0 + 90, x2 - 6, y0 + 90, C.SAND, 1.6))
    b.append(C.label_pill((x1 + col_w + x2) / 2, y0 + 76, "task / submitted", 11, C.SAND))
    b.append(C.arrow(mk, x2 + col_w, y0 + 90, x3 - 6, y0 + 90, C.ZONE_FACE, 1.6))
    b.append(C.label_pill((x2 + col_w + x3) / 2, y0 + 76, "one merged stream", 11, C.ZONE_FACE))

    # ---- the bus band
    bus_y = y0 + max(code_h, agg_h) + 46
    bus_h = 128
    b.append(C.card(PAD, bus_y, W - 2 * PAD, bus_h, "the bus — BusTransport (in-memory today, process next, broker only if reality demands)",
                    accent=C.CORAL, fill=C.CARD_SOFT))
    b.append(C.text(PAD + 20, bus_y + 58, "every event of every lane, wrapped:", 13, C.GREY_MID))
    chips, _ = C.chip_row(PAD + 20, bus_y + 72, ENVELOPE, W - 2 * PAD - 40, C.GREY_LIGHT, 12.5)
    b.append(chips)
    b.append(C.text(PAD + 20, bus_y + bus_h - 14,
                    "self-addressing: correlate by taskId + contextId (no from/to on the envelope) · order per sender: sequence · causality: parentId chain",
                    12, C.GREY_DIM))

    # publish arrows lanes -> bus, drain arrow bus -> aggregator
    b.append(C.arrow(mk, x2 + col_w / 2, y0 + 3 * (lane_h + 14) + 56, x2 + col_w / 2, bus_y - 6, C.CORAL, 1.6))
    b.append(C.label_pill(x2 + col_w / 2, (y0 + 3 * (lane_h + 14) + 56 + bus_y) / 2, "publish(envelope)", 11, C.CORAL))
    b.append(C.arrow(mk, x3 + col_w / 2, bus_y - 6, x3 + col_w / 2, y0 + agg_h, C.ZONE_FACE, 1.6, dash="5 4"))
    b.append(C.label_pill(x3 + col_w / 2, bus_y - 24, "subscribe(topic)", 11, C.ZONE_FACE))

    # ---- choreography strip
    ch_y = bus_y + bus_h + 40
    b.append(C.card(PAD, ch_y, W - 2 * PAD, 96, "the A2A-lite choreography on the stream (what the Spectrum tab folds)"))
    cx = PAD + 20
    for label, note, color in CHOREO:
        seg = C.text(cx, ch_y + 58, label, 13, color, 700, mono=True)
        b.append(seg)
        w1 = C.est_w(label, 13, mono=True)
        b.append(C.text(cx, ch_y + 78, note, 11.5, C.GREY_DIM))
        w2 = C.est_w(note, 11.5)
        cx += max(w1, w2) + 34
        if (label, note, color) != CHOREO[-1]:
            b.append(C.text(cx - 22, ch_y + 58, "→", 13, C.GREY_DIM))

    # ---- legend + provenance
    lg_y = ch_y + 96 + 34
    b.append(C.legend(PAD, lg_y, [
        (C.ZONE_CORE, "lane = core agent", "fill"),
        (C.ZONE_FACE, "aggregator / faces", "fill"),
        (C.CORAL, "live / publish", "fill"),
        (C.SAND, "task assignment", "fill"),
        (C.GREY_MID, "storage / meta", "fill"),
    ]))
    b.append(C.provenance(W, lg_y + 2, "build_14_orchestrator.py"))

    return C.doc(W, lg_y + 40, f"<defs>{mk.defs()}</defs>" + "".join(b), "orchestrator")


if __name__ == "__main__":
    C.write("14-orchestrator-fleet.svg", build())

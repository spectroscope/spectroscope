#!/usr/bin/env python3
"""22 — The llm wire: the one exchange that costs money, written down verbatim.

WHY THIS FIGURE EXISTS. The session file is the app's own protocol — eighteen
typed RunEvents, already summarised, already ours. It is not what the model was
asked and it is not what the model said. That exchange is the expensive one, the
one a bill and a bad answer both come from, and until card 184 it existed only
in flight. Now it lands beside the session as a third file.

WHAT THE GEOMETRY SAYS. The wire between the agent and the backend is drawn as
one unbroken pair of lines, and the recorder hangs BELOW it on dotted taps that
touch the wire without cutting it. That is the whole design claim made
structural: the provider hands the recorder a copy of bytes it was going to send
anyway, so a provider with no tap behaves byte-identically to one without. The
redaction pass sits between the recorder and the file, narrow, and what it stops
is deliberately small — header values, by name. Everything else, including the
whole prompt, goes to disk as it went to the model.

THE TRAP THIS FIGURE EXISTS TO AVOID. The twelve pattern rules (anthropic-key,
jwt, iban, …) are NOT the wire's. They live in graph/Redaction.java and are
applied by StateClipper to the state graph's values file. Documenting them here
would promise credential scrubbing inside prompt bodies that does not exist, so
the figure says out loud where they live.

READ OFF (2026-08-12, branch main):
  spectro-core/.../core/wire/LlmWireRecorder.java   the path rule, the seven
                                                    credential header names, the
                                                    256 MiB ceiling, and the
                                                    three line records with
                                                    every field they carry
  spectro-core/.../core/wire/LlmWireTap.java        the four fidelity labels and
                                                    the four call kinds
  spectro-core/.../core/provider/AnthropicProvider.java   sdk / sdk-json / sdk-events
  spectro-core/.../core/provider/OllamaProvider.java      http / bytes / bytes
  spectro-core/.../core/provider/OpenAiCompatProvider.java
  spectro-server/.../llm/LiveSttSocketHandler.java  transport "websocket", the
                                                    stt- day-file prefix
  spectro-server/.../llm/TranscribeController.java  transport "process"
  spectro-server/.../observability/LlmWireController.java  the three fenced reads
  spectro-core/.../core/graph/Redaction.java        where the twelve patterns
                                                    actually live

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import svg_common as C

W = 1680
PAD = 56

KINDS = ["chat", "compaction", "image", "stt"]

# provider label · who owns the socket · fidelity on the request → on the response
BACKENDS = [
    ("anthropic", "sdk", "sdk-json → sdk-events"),
    ("ollama", "http", "bytes → bytes"),
    ("openai-compat", "http", "bytes → bytes"),
]

# The three line types, with every field the record actually declares.
LINES = [
    ("llm_request", "written at send time",
     "type · xid · agentId · turn · kind · provider · model · transport · "
     "method · url · headers · fidelity · body · bodyBytes · omitted · ts",
     C.ZONE_CORE),
    ("llm_response", "written when the exchange closes",
     "type · xid · agentId · turn · status · fidelity · lines · body · "
     "lineCount · bodyBytes · aborted · error · durationMs · omitted · ts",
     C.ZONE_FACE),
    ("llm_wire_truncated", "written once, at the ceiling",
     "type · reachedBytes · ceilingBytes · ts",
     C.CORAL),
]

CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key",
                      "api-key", "x-goog-api-key", "cookie", "set-cookie"]

# path · what it holds · what switches it on · accent
FAMILY = [
    ("~/.spectro/sessions/<id>.jsonl",
     "the app's own protocol: one appended line per RunEvent — the archive you reopen",
     "always: the session is this file", C.SAND),
    ("~/.spectro/llm-wire/<id>.llm.jsonl",
     "the backend exchange, verbatim: one line out, one line back, paired by xid",
     "always on in the server, the CLI and the headless runner", C.CORAL),
    ("<stem>.graph.jsonl",
     "the topology at compile(), then the seven lifecycle records of the walk",
     "when a caller hands compile() a sink", C.ZONE_CORE),
    ("<stem>.state.jsonl",
     "what the nodes wrote, cut to the tier's caps",
     "off until a caller names a tier", C.ZONE_FACE),
]

READS = [
    ("GET     /api/sessions/{id}/llm-wire",
     "the whole file, one application/x-ndjson attachment"),
    ("GET     /api/sessions/{id}/llm-wire/index",
     "the bodiless ledger — bodies are read past and never returned"),
    ("GET     /api/sessions/{id}/llm-wire/exchange/{xid}",
     "one exchange, both lines, parsed — fetched on the gesture that opens it"),
    ("DELETE  /api/sessions/{id}",
     "cascades to the sidecar unconditionally, so an orphan is deletable too"),
]


def panel(b, x, y, w, title, body, accent, size=12, lead=18):
    """A quiet side note: a titled card whose body is wrapped prose."""
    lines = []
    for para in body:
        lines.extend(C.wrap(para, size, w - 40))
        lines.append("")
    lines = lines[:-1]
    h = 52 + len(lines) * lead + 14
    b.append(C.card(x, y, w, h, accent=accent))
    b.append(C.text(x + 20, y + 30, title, 15, C.WHITE, 700))
    ty = y + 56
    for ln in lines:
        if ln:
            b.append(C.text(x + 20, ty, ln, size, C.GREY_MID))
        ty += lead
    return h


def build():
    mk = C.Markers("wire")
    b = []
    head, y0 = C.header(
        W, "the llm wire", "the one exchange that costs money",
        "The session file is spectroscope's own protocol, already summarised. "
        "What the model was actually asked, and what it actually answered, is "
        "the expensive exchange — and it now lands beside the session as a "
        "third file, verbatim.")
    b.append(head)

    # ==================================================== band 1: the exchange
    y = y0 + 4
    b.append(C.text(PAD, y, "ONE EXCHANGE  ·  THE RECORDER LISTENS, AND THE "
                            "WIRE IS NEVER INTERRUPTED", 12, C.GREY_DIM, mono=True))
    y += 24
    ex_y = y

    # ---- the agent ------------------------------------------------------
    ag_x, ag_w, ag_h = PAD, 300, 140
    b.append(C.card(ag_x, ex_y, ag_w, ag_h, accent=C.ZONE_CORE))
    b.append(C.text(ag_x + 20, ex_y + 30, "spectro-core", 16, C.WHITE, 700))
    b.append(C.text(ag_x + 20, ex_y + 50, "one turn of the agent loop", 12, C.GREY_MID))
    chips, _ = C.chip_row(ag_x + 20, ex_y + 62, KINDS, ag_w - 40, C.GREY_LIGHT, 11,
                          h=22, stroke=C.ZONE_CORE)
    b.append(chips)
    b.append(C.text(ag_x + 20, ex_y + 102, "what the call is FOR is the call", 11.5, C.GREY_DIM))
    b.append(C.text(ag_x + 20, ex_y + 118, "site's knowledge, not the provider's", 11.5, C.GREY_DIM))

    # ---- the backend ----------------------------------------------------
    bk_w = 400
    bk_x = W - PAD - bk_w
    b.append(C.card(bk_x, ex_y, bk_w, ag_h, accent=C.ZONE_EXT))
    b.append(C.text(bk_x + 20, ex_y + 30, "the model backend", 16, C.WHITE, 700))
    b.append(C.text(bk_x + 20, ex_y + 50, "fidelity is recorded, never implied",
                    12, C.GREY_MID))
    ry = ex_y + 72
    for name, transport, fidelity in BACKENDS:
        b.append(C.text(bk_x + 20, ry, name, 11, C.GREY_LIGHT, mono=True))
        b.append(C.text(bk_x + 150, ry, transport, 11, C.CORAL, mono=True))
        b.append(C.text(bk_x + 210, ry, fidelity, 10, C.GREY_MID, mono=True))
        ry += 19

    # ---- the two wires, unbroken ----------------------------------------
    wx1, wx2 = ag_x + ag_w + 6, bk_x - 6
    up_y, dn_y = ex_y + 40, ex_y + 92
    b.append(C.arrow(mk, wx1, up_y, wx2, up_y, C.CORAL, sw=2.2))
    b.append(C.arrow(mk, wx2, dn_y, wx1, dn_y, C.CORAL, sw=2.2))
    b.append(C.label_pill((wx1 + wx2) / 2, up_y - 15,
                          "POST · the request, body verbatim", 10.5, color=C.CORAL))
    b.append(C.label_pill((wx1 + wx2) / 2, dn_y + 15,
                          "the response, line by line", 10.5, color=C.CORAL))

    # ---- the recorder, hanging under the wire on two taps ---------------
    rc_x, rc_w = 440, 800
    rc_y = ex_y + 194
    tap_a, tap_b = 480, 1200
    for tx, from_y in ((tap_a, up_y), (tap_b, dn_y)):
        b.append(C.circle(tx, from_y, 3.6, C.CORAL))
    # the request tap hops over the response wire rather than cutting it
    b.append(C.line(tap_a, up_y + 6, tap_a, dn_y - 8, C.GREY_DIM, 1.2, dash="2 4"))
    b.append(C.arrow(mk, tap_a, dn_y + 8, tap_a, rc_y - 6, C.GREY_DIM, sw=1.2, dash="2 4"))
    b.append(C.arrow(mk, tap_b, dn_y + 6, tap_b, rc_y - 6, C.GREY_DIM, sw=1.2, dash="2 4"))
    b.append(C.text((wx1 + wx2) / 2, dn_y + 46,
                    "the tap is a listener the provider hands its own bytes to — "
                    "the socket is untouched, and a provider with no tap",
                    11.5, C.GREY_DIM, anchor="middle"))
    b.append(C.text((wx1 + wx2) / 2, dn_y + 63,
                    "records nothing and behaves byte-identically to one that "
                    "never had the seam", 11.5, C.GREY_DIM, anchor="middle"))

    rc_h = 196
    b.append(C.card(rc_x, rc_y, rc_w, rc_h, accent=C.SAND))
    b.append(C.text(rc_x + 20, rc_y + 30, "LlmWireRecorder", 16, C.WHITE, 700, mono=True))
    b.append(C.text(rc_x + 218, rc_y + 30,
                    "one file per session, appended, flushed as written",
                    12, C.GREY_MID))
    hy = rc_y + 48
    for call, what, why in [
        ("begin(WireRequest)", "appends llm_request AT SEND TIME",
         "a crash mid-stream still leaves the request on record"),
        ("end(WireOutcome)", "appends llm_response WHEN IT CLOSES",
         "lines for a stream, body for a single payload"),
    ]:
        b.append(C.rect(rc_x + 20, hy, rc_w - 40, 48, C.CARD_UP, C.STROKE, rx=8))
        b.append(C.text(rc_x + 36, hy + 20, call, 12, C.GREY_LIGHT, mono=True))
        b.append(C.text(rc_x + 210, hy + 20, what, 12, C.WHITE, 600))
        b.append(C.text(rc_x + 36, hy + 38, why, 11, C.GREY_MID))
        hy += 56
    b.append(C.text(rc_x + 20, hy + 12,
                    "The two halves pair by xid, never by position — parallel "
                    "subagents share one recorder, and every line is one atomic",
                    11.5, C.GREY_MID))
    b.append(C.text(rc_x + 20, hy + 29,
                    "append with no handle held between lines. A write failure "
                    "prints one stderr line and never kills the run.",
                    11.5, C.GREY_MID))

    # ---- the two side notes, level with the recorder --------------------
    sp_w = rc_x - PAD - 20
    panel(b, PAD, rc_y, sp_w, "there is no switch", [
        "The server, the CLI and the headless runner each construct a recorder "
        "unconditionally. There is no flag, no environment variable and no "
        "settings key that turns it off.",
        "A library caller is the one exception: AgentOptions.llmWire is nullable, "
        "and null records nothing.",
    ], C.CORAL)
    panel(b, rc_x + rc_w + 20, rc_y, W - PAD - rc_x - rc_w - 20,
          "256 MiB, and it latches", [
              "The first payload that would cross the ceiling writes ONE "
              "llm_wire_truncated marker. From then on every body is dropped "
              "with omitted:\"ceiling\" — while the ledger row keeps its measured "
              "bodyBytes, so the count of calls stays true even when the "
              "content stops.",
          ], C.CORAL)

    y = rc_y + rc_h + 40

    # ============================== band 2: the file format + the redaction
    b.append(C.text(PAD, y, "THREE LINE TYPES  ·  AND THE ONLY THING THE WRITER "
                            "STOPS", 12, C.GREY_DIM, mono=True))
    y += 22
    top = y

    lc_w, heights = 288, []
    for i, (name, when, fields, accent) in enumerate(LINES):
        x = PAD + i * (lc_w + 16)
        wrapped = C.wrap(fields, 10.5, lc_w - 36, mono=True)
        h = 74 + len(wrapped) * 15 + 10
        b.append(C.card(x, top, lc_w, h, accent=accent))
        b.append(C.text(x + 18, top + 28, name, 13.5, C.WHITE, mono=True))
        b.append(C.text(x + 18, top + 47, when, 11.5, C.GREY_MID))
        b.append(C.text(x + 18, top + 66, "fields, in declaration order", 10,
                        C.GREY_DIM, mono=True))
        fy = top + 84
        for ln in wrapped:
            b.append(C.text(x + 18, fy, ln, 10.5, C.GREY_LIGHT, mono=True))
            fy += 15
        heights.append(h)
    lines_h = max(heights)
    ly = top + lines_h + 28
    for ln in C.wrap("Serialization is NON_NULL, so an absent field is simply "
                     "missing from the line rather than present as null: a status "
                     "the backend never sent leaves no key behind. And transport "
                     "is the recorded label, not a closed set — sdk, http, "
                     "websocket and process all appear on disk.",
                     12, 3 * lc_w + 32):
        b.append(C.text(PAD, ly, ln, 12, C.GREY_MID))
        ly += 18

    # fidelity is a field, and each label is a separately measured promise
    ly += 16
    b.append(C.text(PAD, ly, "fidelity — the label is a promise somebody measured, "
                             "not a hope", 13.5, C.WHITE, 600))
    ly += 22
    for label, promise in [
        ("bytes", "the recorded string IS what went over the socket"),
        ("sdk-json", "the SDK owned the socket; the request body is byte-equal, "
                     "loopback-proven"),
        ("sdk-events", "rebuilt from the SDK's typed events — content-equal per "
                       "event, keep-alives absent"),
        ("encoded", "the recording's own base64 of real input bytes that never "
                    "rode a socket as a string"),
    ]:
        b.append(C.text(PAD, ly, label, 11.5, C.GREY_LIGHT, mono=True))
        b.append(C.text(PAD + 120, ly, promise, 12, C.GREY_MID))
        ly += 20

    # ---- the redaction gate ---------------------------------------------
    rd_x = PAD + 3 * (lc_w + 16) + 16
    rd_w = W - PAD - rd_x
    rd_rows, cw = 1, 0
    for hdr in CREDENTIAL_HEADERS:              # mirror chip_row's wrap arithmetic
        tw = C.est_w(hdr, 11, True) + 20
        if cw > 0 and cw + tw > rd_w - 40:
            rd_rows, cw = rd_rows + 1, 0
        cw += tw + 8
    rd_note = C.wrap("Names stay, values go, and the map is key-sorted so the file "
                     "is deterministic. n counts UTF-16 code units, which is a small "
                     "oracle and a recorded open finding: the graph layer already "
                     "reports a coarse byte bucket instead, and the wire does not yet.",
                     12, rd_w - 40)
    rd_h = 62 + rd_rows * 32 + 6 + 74 + 22 + (len(rd_note) - 1) * 18 + 18
    b.append(C.card(rd_x, top, rd_w, rd_h, accent=C.CRIMSON))
    b.append(C.text(rd_x + 20, top + 30, "what the writer stops", 16, C.WHITE, 700))
    b.append(C.text(rd_x + 20, top + 50,
                    "credential header VALUES, matched case-insensitively by NAME",
                    12, C.GREY_MID))
    chips, cy = C.chip_row(rd_x + 20, top + 62, CREDENTIAL_HEADERS, rd_w - 40,
                           C.GREY_LIGHT, 11, stroke=C.CRIMSON_DEEP)
    b.append(chips)
    sy = cy + 14
    b.append(C.rect(rd_x + 20, sy, rd_w - 40, 74, C.CARD_UP, C.STROKE, rx=8))
    b.append(C.text(rd_x + 36, sy + 24, "authorization: <the value the provider set>",
                    11.5, C.GREY_MID, mono=True))
    b.append(C.text(rd_x + rd_w - 36, sy + 24, "as the provider set it", 10,
                    C.GREY_DIM, anchor="end"))
    b.append(C.text(rd_x + 36, sy + 46, "authorization: REDACTED(<n> chars)",
                    11.5, C.GREY_LIGHT, mono=True))
    b.append(C.text(rd_x + rd_w - 36, sy + 46, "as it lands on disk", 10,
                    C.GREY_DIM, anchor="end"))
    b.append(C.text(rd_x + 36, sy + 64, "content-type: application/json   ·   "
                                        "passes through, untouched",
                    10.5, C.GREY_DIM, mono=True))
    ny = sy + 74 + 22
    for ln in rd_note:
        b.append(C.text(rd_x + 20, ny, ln, 12, C.GREY_MID))
        ny += 18

    y = top + max(ly - top + 10, rd_h) + 34

    # ---- the trap, said out loud ----------------------------------------
    trap = C.wrap("The full system prompt, the entire replayed history, the tool "
                  "schemas and base64 images ride verbatim — that is the file's "
                  "purpose, and it makes the sidecar exactly as sensitive as the "
                  "conversation itself. The pattern rules (anthropic-key, jwt, iban "
                  "and nine more) belong to graph/Redaction.java and are applied to "
                  "<stem>.state.jsonl; nothing pattern-matches inside a wire body.",
                  12, W - 2 * PAD - 44)
    trap_h = 46 + len(trap) * 18 + 14
    b.append(C.rect(PAD, y, W - 2 * PAD, trap_h, C.CARD_SOFT, C.CRIMSON_DEEP,
                    rx=10, sw=1.2))
    b.append(f'<path d="M{PAD:.1f} {y + 12:.1f} v{trap_h - 24:.1f}" '
             f'stroke="{C.CRIMSON}" stroke-width="3"/>')
    b.append(C.text(PAD + 22, y + 30, "Bodies are never redacted, and the twelve "
                                      "pattern rules are not this file's.",
                    14, C.WHITE, 640))
    ty = y + 56
    for ln in trap:
        b.append(C.text(PAD + 22, ty, ln, 12, C.GREY_MID))
        ty += 18
    y += trap_h + 36

    # ================================================ band 3: the family
    b.append(C.text(PAD, y, "THE FAMILY  ·  WHAT LANDS BESIDE ONE RUN, AND WHAT "
                            "SWITCHES IT ON", 12, C.GREY_DIM, mono=True))
    y += 22
    fam_w = 1020
    for path, holds, switch, accent in FAMILY:
        b.append(C.card(PAD, y, fam_w, 54, accent=accent))
        b.append(C.text(PAD + 20, y + 23, path, 12.5, C.WHITE, mono=True))
        b.append(C.text(PAD + 20, y + 41, holds, 11.5, C.GREY_MID))
        b.append(C.text(PAD + fam_w + 20, y + 33, switch, 11.5, C.GREY_LIGHT))
        y += 62
    y += 12
    for ln in [
        "The wire file sits NEXT TO sessions/, not inside it: the session list reads every sessions/*.jsonl in full, and a "
        "wire file can be orders of magnitude larger than the session it records.",
        "Voice has no session, so both speech routes share a day file instead — stt-<yyyy-MM-dd>.llm.jsonl, in the same "
        "directory, belonging to no session at all.",
        "A finished exchange also becomes a line of the session file, as the llm_exchange RunEvent, appended to the file first "
        "and mirrored to the socket second — so a reopened archive still knows every model call it made, and the bodies stay "
        "in the sidecar.",
        "The graph pair has no fixed home: the caller hands one stem to the two writers and they re-point it, which is exactly "
        "how the bundled demo scenarios were produced — by the engine's own test, not by hand.",
    ]:
        for part in C.wrap(ln, 12.5, W - 2 * PAD):
            b.append(C.text(PAD, y, part, 12.5, C.GREY_MID))
            y += 19
        y += 4

    # ================================================ band 4: how to read it
    y += 18
    b.append(C.text(PAD, y, "HOW THE FILE IS READ, AND HOW IT GOES AWAY  ·  THE THREE READS ARE FENCED TO LOOPBACK",
                    12, C.GREY_DIM, mono=True))
    y += 20
    for route, what in READS:
        # Drawn RAW rather than through C.text, for xml:space="preserve" alone:
        # the verb column is padded with spaces and the default collapses runs
        # of them, which put all four paths at a different x each.
        b.append(f'<text x="{PAD:.1f}" y="{y + 14:.1f}" fill="{C.GREY_LIGHT}" '
                 f'font-size="12" font-weight="400" text-anchor="start" '
                 f'font-family="{C.MONO}" xml:space="preserve">'
                 f'{C.escape(route)}</text>')
        b.append(C.text(PAD + 470, y + 14, what, 12, C.GREY_MID))
        y += 26
    y += 10
    b.append(C.text(PAD, y, "In the browser there is no wire tab: the surface is the "
                            "session's trace tab, where one exchange becomes three rows "
                            "and an expanded row offers three faces. The whole file "
                            "downloads from the archive bar of a",
                    12.5, C.GREY_MID))
    y += 19
    b.append(C.text(PAD, y, "stored session, beside export, and only when the index "
                            "answered non-empty — so the link never names an empty file.",
                    12.5, C.GREY_MID))
    y += 40

    b.append(C.line(PAD, y - 18, W - PAD, y - 18, C.STROKE_SOFT))
    b.append(C.legend(PAD, y + 6, [
        (C.CORAL, "the network boundary · the exchange itself", "fill"),
        (C.SAND, "the recorder and the session's own stream", "stroke"),
        (C.CRIMSON, "what is guarded, and what is not", "stroke"),
        (C.GREY_DIM, "dotted = the tap: a copy, not a hop", "dash"),
    ]))
    b.append(C.provenance(W, y + 6, "build_22_llm_wire.py"))
    return C.doc(W, y + 34, f"<defs>{mk.defs()}</defs>" + "".join(b), "22-llm-wire")


if __name__ == "__main__":
    C.write("22-llm-wire.svg", build())

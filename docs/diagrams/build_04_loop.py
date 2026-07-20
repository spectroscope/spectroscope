#!/usr/bin/env python3
"""04 - One turn through the loop: stream, gate, tool, repeat.

Three lanes: face+human, agent, and a shared right column where the provider
and the tools stack vertically in step order (each side only has two touch
points, so neither needs its own full-height lane and no arrow crosses the
other's territory).

Source-verified against spectro-core/.../core/Agent.java (runGuarded order), HookRunner,
Allowlist, StandardTools/ShellCommand and Compaction on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

LANE_W = (W - 2 * PAD - 2 * 28) / 3


def lane_x(i):
    return PAD + i * (LANE_W + 28)


def build():
    mk = C.Markers("loop")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 04",
        "One turn through the loop.",
        "The agent streams a model turn, guards every tool call through hooks, allowlist and the human gate, "
        "feeds the result back, and repeats until the model stops calling tools.")
    b.append(head)

    top = y0 + 34
    H = 1180

    # ---- lane backgrounds (face + agent); the right column gets stacked zones
    for name, color, i in [("FACE + HUMAN", C.ZONE_FACE, 0), ("AGENT (spectro-core)", C.ZONE_CORE, 1)]:
        x = lane_x(i)
        b.append(C.rect(x, top, LANE_W, H, C.CARD_SOFT, C.STROKE_SOFT, rx=12))
        b.append(C.text(x + 14, top - 12, name, 12, C.GREY_MID, ls="0.12em"))
        b.append(f'<path d="M{x + 12} {top + 6} h36" stroke="{color}" stroke-width="3"/>')

    def box(lane, y, title, sub, h=None, accent=None, event=None, dash=None, x_override=None, w_override=None):
        x = (x_override if x_override is not None else lane_x(lane)) + 14
        w = (w_override if w_override is not None else LANE_W) - 28
        subs = []
        for s in sub:
            subs.extend(C.wrap(s, 10.8, w - 24, mono=True))
        h = h or (30 + len(subs) * 15 + 10)
        b.append(C.rect(x, y, w, h, C.CARD, accent or C.STROKE, rx=9, sw=1.2, dash=dash))
        b.append(C.text(x + 12, y + 20, title, 12.5, C.WHITE, 700))
        for i, ln in enumerate(subs):
            b.append(C.text(x + 12, y + 38 + i * 15, ln, 10.8, C.GREY_MID, mono=True))
        if event:
            ex = x + w - C.est_w(event, 10, True) - 18
            b.append(C.rect(ex, y - 9, C.est_w(event, 10, True) + 14, 18, C.EBONY, C.SAND_DEEP, rx=9))
            b.append(C.text(ex + 7, y + 4, event, 10, C.SAND, mono=True))
        return y + h

    def flow(x1, y1, x2, y2, color=C.GREY_MID, dash=None, label=None):
        if abs(y1 - y2) < 4:
            b.append(C.arrow(mk, x1, y1, x2, y2, color, dash=dash))
        else:
            mx = (x1 + x2) / 2
            b.append(C.path_arrow(mk, f"M{x1} {y1} C {mx} {y1}, {mx} {y2}, {x2 - 6 if x2 > x1 else x2 + 6} {y2}",
                                  color, dash=dash))
        if label:
            b.append(C.label_pill((x1 + x2) / 2, (y1 + y2) / 2 - 12, label, 10))

    L0, L1, L2 = (lane_x(i) for i in range(3))
    R0, R1 = L0 + LANE_W, L1 + LANE_W

    y = top + 30
    y_prompt = y
    box(0, y, "1 · prompt", ["user_message over /ws, REPL line,", "or spectro run -p (headless)"], event="run_start")
    flow(R0 - 14, y_prompt + 24, L1 + 14, y_prompt + 24, C.ZONE_FACE)

    # ---- provider zone (right column, top): drawn first so nothing is covered
    y = y_prompt + 92
    prov_top = top
    prov_h = y + 8 + 85 + 40 - prov_top  # step-3 card is 3 lines high (85px)
    b.append(C.rect(L2, prov_top, LANE_W, prov_h, C.CARD_SOFT, C.STROKE_SOFT, rx=12))
    b.append(C.text(L2 + 14, prov_top - 12, "PROVIDER / LLM", 12, C.GREY_MID, ls="0.12em"))
    b.append(f'<path d="M{L2 + 12} {prov_top + 6} h36" stroke="{C.ZONE_EXT}" stroke-width="3"/>')

    box(1, y, "2 · build the request", [
        "system = BASE + cwd + SPECTRO.md", "+ skills catalog (names only)",
        "history + 19 tool specs", "attachments reloaded from blobs"], event="turn_start")
    y2 = y + 108
    flow(R1 - 14, y + 30, L2 + 14, y + 30, C.ZONE_CORE)
    b.append(C.label_pill(R1 - 92, y + 16, "provider.stream(request)", 10))

    box(2, y + 8, "3 · the model streams", [
        "thinking deltas (if enabled)", "text deltas", "tool calls, usage, stop reason"],
        event="thinking_delta · text_delta", w_override=LANE_W - 24)
    flow(L2 + 14, y + 96, R1 - 14, y + 96, C.ZONE_EXT)
    b.append(C.label_pill(L2 + 60, y + 112, "PToolCall?", 10))

    y = y2 + 44
    box(1, y, "4 · a tool call arrives", ["Agent.runGuarded(call) begins"], event="tool_call")

    y += 66
    yh = box(1, y, "5 · pre_tool_use hook", [
        "HookRunner: shell command, 10 s,", "fail-open on timeout",
        "non-zero exit or {decision:block}", "kills the call BEFORE any gate"], accent=C.CRIMSON_DEEP)
    flow(L1 + 14, y + 24, R0 - 40, y + 24, C.CRIMSON, dash="5 4", label="blocked")
    box(0, y + 40, "blocked result", ["ERROR: blocked by pre_tool_use", "hook (isError, no dialog)"],
        dash="5 4", accent=C.CRIMSON_DEEP)

    y = yh + 26
    ya = box(1, y, "6 · the permission gate", [
        "needsPermission?  no -> run it",
        "Allowlist.allows(request)?",
        "autoApprove + session rules,",
        "prefix-scoped per guardedField",
        "hit -> auto-approved, no dialog"], accent=C.ZONE_CORE_DEEP)

    y_ask = ya + 26
    box(0, y_ask - 8, "7 · the human decides", [
        "web dialog / CLI [y/N]",
        "checkboxes: remember (session)", "persist -> SettingsWriter appends",
        "rule to .spectro/settings.json"], accent=C.CORAL)
    flow(L1 + 14, y_ask + 4, R0 - 14, y_ask + 4, C.CORAL, label="permission_request")
    flow(R0 - 14, y_ask + 44, L1 + 14, y_ask + 44, C.CORAL, label="permission_decision")
    b.append(C.text(L0 + 24, y_ask + 112, "the broker BLOCKS the run until this", 10.5, C.GREY_DIM, mono=True))
    b.append(C.text(L0 + 24, y_ask + 127, "future completes (real waiting state)", 10.5, C.GREY_DIM, mono=True))

    # ---- tools zone (right column, stacked below the provider zone) --------
    # Geometry first, so the zone background never covers a card or an arrow:
    # three fixed-height cards (85 / 85 / 70) around the execute/result hops.
    y = y_ask + 78
    tools_top = y - 240
    yto = y + 8 + 70
    tz_top = tools_top - 34
    b.append(C.rect(L2, tz_top, LANE_W, yto + 20 - tz_top, C.CARD_SOFT, C.STROKE_SOFT, rx=12))
    b.append(C.text(L2 + 14, tz_top - 12, "TOOLS + OS", 12, C.GREY_MID, ls="0.12em"))
    b.append(f'<path d="M{L2 + 12} {tz_top + 6} h36" stroke="{C.ZONE_DISK}" stroke-width="3"/>')

    yt = box(1, y, "8 · execute", ["allowed -> registry.get(name)", ".execute(input, ToolContext)"])
    flow(R1 - 14, y + 24, L2 + 14, y + 24, C.ZONE_DISK)
    b.append(C.label_pill(R1 - 64, y + 10, "sandboxed", 10))

    box(2, tools_top, "the sandbox", [
        "resolveInside(cwd, path): normalize, refuse escapes",
        "walks prune .git/build/node_modules/target",
        "+ re-check symlinks via toRealPath()"], accent=C.ZONE_DISK_DEEP)
    box(2, y - 130, "run_command", [
        "/bin/sh -c · 10 s timeout · stderr merged",
        "pipe drained on a virtual thread (no deadlock)",
        "cancel kills the child"], accent=C.ZONE_DISK_DEEP)
    box(2, y + 8, "every tool result", [
        "never throws: failures return ERROR: ... as output",
        "ToolOutput clips at 10,000 chars, surrogate-safe"], accent=C.ZONE_DISK_DEEP)
    flow(L2 + 14, yto - 16, R1 - 14, yto - 16, C.ZONE_DISK)

    y = yt + 30
    box(1, y, "9 · post_tool_use hook", ["advisory only: exit code ignored"], dash="5 4")
    y += 64
    yr = box(1, y, "10 · feed back + loop", [
        "tool_result joins the history;", "back to step 2 until the model", "stops calling tools"],
        event="tool_result")
    b.append(C.path_arrow(mk, f"M{L1 + 8} {yr - 30} C {L1 - 34} {yr - 30}, {L1 - 34} {y_prompt + 130}, {L1 + 8} {y_prompt + 130}",
                          C.GREY_MID, dash="2 4"))

    y = yr + 28
    yc = box(1, y, "11 · housekeeping per turn", [
        "contextTokens = input + cacheRead", "+ cacheCreation (real window)",
        "over threshold (100k default) ->", "Compaction.maybeCompact: keep 4,",
        "summarize the rest (no tools);", "JSONL is never rewritten"],
        event="context_info · compaction")
    box(2, y + 20, "compaction summary call (provider)", [
        "one provider run WITHOUT tools", "turns the old turns into a summary"],
        accent=C.ZONE_EXT, dash="5 4")
    flow(R1 - 14, y + 44, L2 + 14, y + 44, C.GREY_DIM, dash="5 4")

    y = yc + 28
    ye = box(1, y, "12 · the run ends", ["stop reason END_TURN / MAX_TOKENS /", "ABORTED (CancelSignal, coral path)"],
             event="usage · run_end")
    flow(L1 + 14, ye - 24, R0 - 14, ye - 24, C.ZONE_FACE)
    box(0, ye - 48, "render + persist", ["every face just renders the stream;", "SessionStore appended each event"])

    ly = top + H + 36
    b.append(C.legend(PAD, ly, [
        (C.SAND, "emitted RunEvent", "stroke"),
        (C.CORAL, "human decision / cancel", "fill"),
        (C.CRIMSON_DEEP, "hook guard", "stroke"),
        (C.ZONE_EXT, "provider zone", "stroke"),
        (C.ZONE_DISK_DEEP, "OS side effects", "stroke"),
        (C.GREY_MID, "dotted = the loop", "dash"),
    ]))
    b.append(C.provenance(W, ly, "build_04_loop.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "loop")


if __name__ == "__main__":
    C.write("04-agent-loop.svg", build())

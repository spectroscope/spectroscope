#!/usr/bin/env python3
"""06 — Delegation: subagents and the A2A-lite protocol between them.

Source-verified against spectro-core/.../core/subagents/SubagentManager.java,
RoleCatalog.java, AgentType.java and MergedEventStream on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56


def build():
    mk = C.Markers("subagents")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 06",
        "Delegation: agents spawning agents.",
        "The parent agent spawns typed children through ordinary tools. Every child is its own loop with its own "
        "toolset and CancelSignal; an additive agent_message lifecycle makes the protocol between them visible.")
    b.append(head)

    top = y0 + 10
    # ---- left: parent + manager -----------------------------------------
    lx, lw = PAD, 470
    b.append(C.card(lx, top, lw, 210, "Parent agent (main)", accent=C.ZONE_CORE))
    b.append(C.text(lx + 16, top + 50, "gets from SubagentManager:", 12.5, C.GREY_MID))
    s, ny = C.chip_row(lx + 16, top + 64, ["spawn_agent", "spawn_agents", "build_plan", "write_spec", "develop", "test"],
                       lw - 32, C.GREY_LIGHT, 12)
    b.append(s)
    b.append(C.text(lx + 16, ny + 24, "dev tools are thin role wrappers over a worker", 11.5, C.GREY_MID))
    b.append(C.text(lx + 16, ny + 42, "spawn: no new agent type, prompt + skill only", 11.5, C.GREY_MID))

    my = top + 210 + 26
    b.append(C.card(lx, my, lw, 250, "SubagentManager", accent=C.ZONE_CORE))
    mgr = [
        "MAX_PARALLEL_CHILDREN = 4",
        "CHILD_TIMEOUT_MS = 120,000",
        "child ids: explore-1, worker-2, ...",
        "children NEVER get spawn/dev tools",
        "(nesting depth 1 by construction)",
        "every child also gets report_status",
        "parent cancel cascades per-child signals",
        "children run the parent's HookRunner",
    ]
    for i, ln in enumerate(mgr):
        b.append(C.text(lx + 16, my + 50 + i * 20, ln, 11.8, C.GREY_MID, mono=True))

    sy = my + 250 + 26
    b.append(C.card(lx, sy, lw, 130, "MergedEventStream", accent=C.ZONE_CORE))
    ms = [
        "one LinkedBlockingQueue, many producers",
        "spectroscope-parent-pump virtual thread drains parent,",
        "each child adds itself as a producer",
        "every child event carries its own agentId",
    ]
    for i, ln in enumerate(ms):
        b.append(C.text(lx + 16, sy + 48 + i * 19, ln, 11.8, C.GREY_MID, mono=True))

    # ---- middle: roles ---------------------------------------------------
    mx, mw = lx + lw + 60, 470
    b.append(C.text(mx, top + 4, "ROLE CATALOG", 12, C.GREY_MID, ls="0.12em"))
    ry = top + 18
    b.append(C.card(mx, ry, mw, 150, "explore (read-only scout)", accent=C.ZONE_DISK_DEEP))
    b.append(C.text(mx + 16, ry + 48, "EXPLORE_TOOL_NAMES:", 12, C.GREY_MID, mono=True))
    s, _ = C.chip_row(mx + 16, ry + 62, ["list_dir", "read_file", "glob", "grep"], mw - 32, C.GREY_LIGHT, 12)
    b.append(s)
    b.append(C.text(mx + 16, ry + 124, "own system prompt from RoleCatalog.SYSTEM_PROMPTS", 11.3, C.GREY_MID, mono=True))
    ry += 150 + 20
    b.append(C.card(mx, ry, mw, 116, "worker (does the work)", accent=C.ZONE_FACE_DEEP))
    b.append(C.text(mx + 16, ry + 48, "the full child base toolset (files, shell, web, ...)", 11.8, C.GREY_MID, mono=True))
    b.append(C.text(mx + 16, ry + 68, "+ use_skill when skills are loaded", 11.8, C.GREY_MID, mono=True))
    b.append(C.text(mx + 16, ry + 88, "dev tools point it at a skill:", 11.8, C.GREY_MID, mono=True))
    ry += 116 + 20
    b.append(C.card(mx, ry, mw, 168, "DevSpec: tool -> skill", accent=C.ZONE_FACE_DEEP))
    rows = [("build_plan", "writing-plans"), ("write_spec", "brainstorming"),
            ("develop", "test-driven-development"), ("test", "verification")]
    yy = ry + 48
    for tool, skill in rows:
        b.append(C.text(mx + 16, yy, tool, 12.5, C.GREY_LIGHT, mono=True))
        b.append(C.arrow(mk, mx + 150, yy - 4, mx + 195, yy - 4, C.GREY_DIM))
        b.append(C.text(mx + 205, yy, skill, 12.5, C.GREY_MID, mono=True))
        yy += 28
    ry += 168 + 20
    b.append(C.card(mx, ry, mw, 122, "Introspection (feeds /api/context)", accent=C.ZONE_CORE))
    b.append(C.text(mx + 16, ry + 48, "RoleCatalog.roleProfiles(childBaseToolNames)", 11.8, C.GREY_MID, mono=True))
    b.append(C.text(mx + 16, ry + 68, "-> RoleProfile(type, kind, systemPrompt, tools,", 11.8, C.GREY_MID, mono=True))
    b.append(C.text(mx + 16, ry + 88, "   readOnly, skill) · parentTools() summaries", 11.8, C.GREY_MID, mono=True))

    # ---- right: A2A sequence ---------------------------------------------
    ax = mx + mw + 60
    aw = W - PAD - ax
    b.append(C.text(ax, top + 4, "THE A2A-LITE LIFECYCLE (additive agent_message)", 12, C.GREY_MID, ls="0.12em"))
    ay = top + 30
    lane_p = ax + 70
    lane_c = ax + aw - 70
    seq_h = 470
    b.append(C.line(lane_p, ay + 26, lane_p, ay + seq_h, C.STROKE))
    b.append(C.line(lane_c, ay + 26, lane_c, ay + seq_h, C.STROKE))
    b.append(C.text(lane_p, ay + 12, "parent", 12.5, C.GREY_LIGHT, anchor="middle", mono=True))
    b.append(C.text(lane_c, ay + 12, "worker-1", 12.5, C.GREY_LIGHT, anchor="middle", mono=True))

    def msg(y, frm, to, label, color=C.GREY_MID, dash=None, sub=None):
        x1 = lane_p if frm == "p" else lane_c
        x2 = lane_c if to == "c" else lane_p
        b.append(C.arrow(mk, x1, y, x2 - 8 if x2 > x1 else x2 + 8, y, color, dash=dash))
        b.append(C.text((x1 + x2) / 2, y - 8, label, 11.3, color if color != C.GREY_MID else C.GREY_LIGHT,
                        anchor="middle", mono=True))
        if sub:
            b.append(C.text((x1 + x2) / 2, y + 15, sub, 10, C.GREY_DIM, anchor="middle", mono=True))

    yy = ay + 56
    msg(yy, "p", "c", "agent_spawn", C.SAND, sub="agentId=worker-1 · parentId=main · task")
    yy += 52
    msg(yy, "p", "c", "agent_message: task", C.SAND, sub="role=task · state=submitted · label=build_plan")
    yy += 58
    b.append(C.rect(lane_c - 46, yy - 12, 92, 26, C.CARD_UP, C.ZONE_FACE_DEEP, rx=8))
    b.append(C.text(lane_c, yy + 5, "runs its loop", 10.5, C.GREY_MID, anchor="middle"))
    yy += 44
    msg(yy, "c", "p", "agent_message: status", C.SAND, sub="report_status tool · state=working")
    yy += 52
    msg(yy, "c", "p", "tool_call / tool_result / deltas", C.GREY_MID, dash="4 3",
        sub="ordinary events, own agentId")
    yy += 52
    msg(yy, "c", "p", "agent_message: result", C.SAND, sub="state=completed | failed · outcome text")
    yy += 52
    b.append(C.text((lane_p + lane_c) / 2, yy + 6,
                    "the UI folds these for free:", 11.3, C.GREY_MID, anchor="middle"))
    b.append(C.text((lane_p + lane_c) / 2, yy + 24,
                    "chat threads · Lab loops · roster", 11.3, C.GREY_MID, anchor="middle"))

    # gate note under sequence
    gy = ay + seq_h + 40
    b.append(C.card(ax, gy, aw, 150, "Gates + hooks apply to children too", accent=C.CORAL))
    gn = [
        "a child's permission_request rides the SAME",
        "broker to the human; permission_decision",
        "carries no agentId and is routed back by",
        "callId (gateOwners in the web Lab)",
        "children inherit the parent HookRunner",
    ]
    for i, ln in enumerate(gn):
        b.append(C.text(ax + 16, gy + 46 + i * 19, ln, 11.3, C.GREY_MID, mono=True))

    bottom = max(sy + 130, ry + 122, gy + 150) + 40
    b.append(C.legend(PAD, bottom, [
        (C.SAND, "additive A2A events", "fill"),
        (C.ZONE_DISK_DEEP, "read-only role", "stroke"),
        (C.ZONE_FACE_DEEP, "worker role", "stroke"),
        (C.CORAL, "gate", "stroke"),
    ]))
    b.append(C.provenance(W, bottom, "build_06_subagents.py"))
    return C.doc(W, bottom + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "subagents")


if __name__ == "__main__":
    C.write("06-subagents-a2a.svg", build())

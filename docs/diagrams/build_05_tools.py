#!/usr/bin/env python3
"""05 — The tool belt: all 19 tools and how each one is guarded.

Source-verified against spectro-core/.../core/tools/*, image/GenerateImageTool,
skills/SkillLibrary, subagents/SubagentManager + RoleCatalog, mcp/McpTool
and permission/Allowlist on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

FREE, GATE, PREFIX = "free", "gated", "gated + rule"

GROUPS = [
    ("Files + search", C.ZONE_DISK_DEEP, [
        ("list_dir", FREE, "list a directory (sandboxed)"),
        ("read_file", FREE, "read text, max 50 kB"),
        ("glob", FREE, "pattern find, pruned walk, cap 200"),
        ("grep", FREE, "regex search: path:line:text"),
        ("write_file", PREFIX, "write + mkdirs · rule scoped by path"),
        ("edit_file", PREFIX, "exact-string replace, unique match · by path"),
    ]),
    ("Execution + network", C.CRIMSON_DEEP, [
        ("run_command", PREFIX, "/bin/sh -c, 10 s · rule scoped by first token"),
        ("web_fetch", PREFIX, "http(s) via HttpFetcher, HTML to text · by url"),
    ]),
    ("Media + knowledge", C.ZONE_EXT_DEEP, [
        ("generate_image", GATE, "paid cloud call -> ImageStore + image_generated"),
        ("use_skill", FREE, "return a SKILL.md body on demand"),
        ("update_plan", FREE, "emit the plan event · main agent only"),
    ]),
    ("Delegation (parent only)", C.ZONE_FACE_DEEP, [
        ("spawn_agent", FREE, "one child: explore or worker · waits"),
        ("spawn_agents", FREE, "up to 4 children in parallel"),
        ("build_plan", FREE, "worker + writing-plans skill"),
        ("write_spec", FREE, "worker + brainstorming skill"),
        ("develop", FREE, "worker + test-driven-development skill"),
        ("test", FREE, "worker + verification skill"),
    ]),
    ("Child side + MCP", C.ZONE_FACE_DEEP, [
        ("report_status", FREE, "child -> parent agent_message (working)"),
        ("mcp__<server>__<tool>", GATE, "proxy to a remote MCP tool · dynamic set"),
    ]),
]

BADGE = {FREE: (C.ZONE_DISK, "free"), GATE: (C.CORAL, "gate"),
         PREFIX: (C.CORAL, "gate + prefix rule")}


def build():
    mk = C.Markers("tools")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 05",
        "The tool belt.",
        "19 tools behind one registry and one gate. Read-only tools run free; anything that writes, executes, "
        "spends money or leaves the machine asks first. Course maxim: tool inputs are model output, and therefore untrusted.")
    b.append(head)

    col_w = (W - 2 * PAD - 2 * 28) / 3
    cols = [PAD + i * (col_w + 28) for i in range(3)]
    col_y = [y0 + 10] * 3
    placement = [0, 0, 1, 1, 2]

    for gi, (gname, accent, tools) in enumerate(GROUPS):
        ci = placement[gi]
        x, y = cols[ci], col_y[ci]
        h = 44 + len(tools) * 44 + 8
        b.append(C.card(x, y, col_w, h, gname, accent=accent))
        ty = y + 44
        for name, kind, desc in tools:
            bc, blabel = BADGE[kind]
            b.append(C.text(x + 16, ty + 14, name, 13, C.GREY_LIGHT, mono=True))
            bw = C.est_w(blabel, 10) + 14
            b.append(C.rect(x + col_w - bw - 14, ty + 2, bw, 17,
                            C.EBONY, bc, rx=8.5, sw=1.1))
            b.append(C.text(x + col_w - bw / 2 - 14, ty + 14, blabel, 10,
                            C.GREY_LIGHT, anchor="middle"))
            b.append(C.text(x + 16, ty + 32, desc, 10.8, C.GREY_MID))
            ty += 44
        col_y[ci] = y + h + 22

    # column 3: safety cards
    x = cols[2]
    y = col_y[2]
    b.append(C.card(x, y, col_w, 208, "The sandbox", accent=C.ZONE_DISK_DEEP))
    sb = [
        "resolveInside(cwd, path): normalize,",
        "refuse anything outside the working dir",
        "tree walks prune .git · build · node_modules",
        "· target, then re-check symlink escapes",
        "via toRealPath()",
        "",
        "ShellCommand: stderr merged, output pipe",
        "drained on a virtual thread, cancel kills",
    ]
    for i, ln in enumerate(sb):
        b.append(C.text(x + 16, y + 48 + i * 19, ln, 11.3, C.GREY_MID, mono=True))
    y += 208 + 22

    b.append(C.card(x, y, col_w, 190, "Tool contract", accent=C.ZONE_CORE_DEEP))
    tc = [
        "String execute(JsonNode input, ToolContext)",
        "never throws: failures return ERROR: ...",
        "ToolOutput: one shared 10,000-char clip,",
        "surrogate-safe",
        "ToolContext(cwd, signal, agentId, callId,",
        "emit) · tools can emit additive events",
    ]
    for i, ln in enumerate(tc):
        b.append(C.text(x + 16, y + 48 + i * 19, ln, 11.3, C.GREY_MID, mono=True))
    y += 190 + 22
    col_y[2] = y

    # allowlist band across the bottom
    ay = max(col_y) + 4
    b.append(C.card(PAD, ay, W - 2 * PAD, 128, "Allowlist: what a remembered \"always allow\" actually covers", accent=C.CORAL))
    b.append(C.text(PAD + 16, ay + 48,
                    "one guardedField map feeds remembering AND matching, so a click never becomes a blanket approval:",
                    12.5, C.GREY_LIGHT))
    rules = ["run_command : command (first token)   e.g. run_command:git*",
             "write_file / edit_file : path", "web_fetch : url", "other tools : bare name"]
    s, _ = C.chip_row(PAD + 16, ay + 62, rules, W - 2 * PAD - 32, C.GREY_LIGHT, 11.5)
    b.append(s)
    b.append(C.text(PAD + 16, ay + 116,
                    "sources: project autoApprove rules + session-remembered rules · persist appends via SettingsWriter (read-modify-write, no clobber)",
                    11.5, C.GREY_MID))

    ly = ay + 128 + 38
    b.append(C.legend(PAD, ly, [
        (C.ZONE_DISK, "free (read-only or harmless)", "stroke"),
        (C.CORAL, "gated by the permission broker", "stroke"),
        (C.ZONE_FACE_DEEP, "delegation", "stroke"),
        (C.ZONE_EXT_DEEP, "external side effects", "stroke"),
    ]))
    b.append(C.provenance(W, ly, "build_05_tools.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "tools")


if __name__ == "__main__":
    C.write("05-tool-belt.svg", build())

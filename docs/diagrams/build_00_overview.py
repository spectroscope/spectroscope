#!/usr/bin/env python3
"""00 — The big picture: one headless core, five faces, one event wire.

Source-verified against spectro-core/, spectro-cli/, spectro-server/, spectro-web/,
spectro-desktop/ and the ./spectro launcher on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56


def build():
    mk = C.Markers("overview")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 00",
        "One core, five faces.",
        "spectro-core is a container-free Java 21 library that emits one typed RunEvent stream. "
        "Every face is a renderer of that stream; the stream is also the storage format and the graph source.")
    b.append(head)

    # ---- geometry -------------------------------------------------------
    prov_x, prov_w = PAD, 312
    core_x, core_w = 440, 536
    face_x = 1126
    face_w = W - PAD - face_x
    top_y = y0 + 8

    # ---- providers zone (left, salmon) ---------------------------------
    b.append(C.text(prov_x, top_y + 4, "MODEL SIDE", 12.5, C.GREY_MID, ls="0.14em"))
    py = top_y + 18
    b.append(C.card(prov_x, py, prov_w, 306, "LLM providers", accent=C.ZONE_EXT))
    b.append(C.text(prov_x + 16, py + 48, "behind one port: LlmProvider.stream()", 12.5, C.GREY_MID))
    rows = [
        ("AnthropicProvider", "official SDK · SSE · prompt caching"),
        ("OllamaProvider", "RestClient · NDJSON · local, key-free"),
        ("OpenAiCompatProvider", "SSE · any OpenAI-style server"),
    ]
    ry = py + 66
    for name, sub in rows:
        b.append(C.rect(prov_x + 16, ry, prov_w - 32, 48, C.CARD_UP, C.STROKE, rx=8))
        b.append(C.text(prov_x + 28, ry + 20, name, 13.5, C.GREY_LIGHT, mono=True))
        b.append(C.text(prov_x + 28, ry + 37, sub, 11.5, C.GREY_MID))
        ry += 56
    b.append(C.text(prov_x + 16, ry + 16, "wrapped: Switchable( Retrying( .. ) )", 12, C.GREY_MID, mono=True))
    b.append(C.text(prov_x + 16, ry + 34, "swap mid-session · retry before first event", 11.5, C.GREY_DIM))

    iy = py + 306 + 22
    b.append(C.card(prov_x, iy, prov_w, 138, "Image providers", accent=C.ZONE_EXT))
    b.append(C.text(prov_x + 16, iy + 48, "second port: ImageProvider.generate()", 12.5, C.GREY_MID))
    s, _ = C.chip(prov_x + 16, iy + 62, "GeminiImageProvider", C.GREY_LIGHT, 12.5)
    b.append(s)
    s, _ = C.chip(prov_x + 16, iy + 96, "OpenAiImageProvider", C.GREY_LIGHT, 12.5)
    b.append(s)
    b.append(C.text(prov_x + 196, iy + 78, "gemini-2.5-flash-image", 10.5, C.GREY_DIM, mono=True))
    b.append(C.text(prov_x + 196, iy + 112, "gpt-image-1", 10.5, C.GREY_DIM, mono=True))

    my = iy + 138 + 22
    b.append(C.card(prov_x, my, prov_w, 96, "MCP servers (external)", accent=C.ZONE_EXT, dash="6 4"))
    b.append(C.text(prov_x + 16, my + 48, "stdio (child process) · HTTP + SSE", 12.5, C.GREY_MID))
    b.append(C.text(prov_x + 16, my + 68, "e.g. spectro-mcp-notes · JSON-RPC 2.0", 12, C.GREY_DIM, mono=True))

    # ---- the core (center, ocean) --------------------------------------
    b.append(C.text(core_x, top_y + 4, "THE CORE", 12.5, C.GREY_MID, ls="0.14em"))
    cy = top_y + 18
    core_h = 556
    b.append(C.card(core_x, cy, core_w, core_h, None, fill=C.CARD_SOFT, stroke=C.ZONE_CORE_DEEP))
    b.append(C.text(core_x + 20, cy + 32, "spectro-core", 19, C.WHITE, 700))
    b.append(C.text(core_x + 130, cy + 32, "headless Java 21 library · plain new · no Boot", 12.5, C.GREY_MID))
    inner = [
        ("Agent", "the loop: prompt, stream, tools, repeat"),
        ("SubagentManager", "spawn explore/worker children · A2A-lite"),
        ("ToolRegistry", "19 tools: files, shell, web, image, skills, plan, MCP"),
        ("PermissionBroker + Allowlist", "blocking gate · prefix rules"),
        ("HookRunner", "pre/post_tool_use shell hooks · fail-open"),
        ("SkillLibrary", "SKILL.md packages · progressive disclosure"),
        ("McpServerRegistry", "external tools as ordinary Tools"),
        ("SessionStore + Compaction", "JSONL append · blobs · resume"),
        ("CronScheduler + HeadlessRunner", "unattended runs · jobs.json"),
    ]
    ry = cy + 52
    for name, sub in inner:
        b.append(C.rect(core_x + 20, ry, core_w - 40, 44, C.CARD, C.STROKE, rx=8))
        b.append(C.text(core_x + 34, ry + 19, name, 13.5, C.GREY_LIGHT, mono=True))
        b.append(C.text(core_x + 34, ry + 35, sub, 11.5, C.GREY_MID))
        ry += 50
    b.append(C.text(core_x + 20, ry + 16,
                    "virtual threads + blocking style · EventStream = blocking Iterable<RunEvent>",
                    11.5, C.GREY_DIM))

    # arrows providers -> core, with pill labels
    gap1_mid = (prov_x + prov_w + core_x) / 2
    b.append(C.arrow(mk, prov_x + prov_w, py + 150, core_x - 6, py + 150, C.ZONE_EXT))
    b.append(C.label_pill(gap1_mid, py + 134, "LlmProvider"))
    b.append(C.arrow(mk, prov_x + prov_w, iy + 66, core_x - 6, iy + 66, C.ZONE_EXT))
    b.append(C.label_pill(gap1_mid, iy + 50, "ImageProvider"))
    b.append(C.arrow(mk, prov_x + prov_w, my + 48, core_x - 6, my + 48, C.ZONE_EXT, dash="5 4"))
    b.append(C.label_pill(gap1_mid, my + 32, "McpTransport"))

    # ---- faces (right, lilac) ------------------------------------------
    b.append(C.text(face_x, top_y + 4, "FIVE FACES", 12.5, C.GREY_MID, ls="0.14em"))
    fy = top_y + 18
    faces = [
        ("spectro-cli", "picocli terminal", "repl · run · cron · doctor · EventRenderer · --verbose wire trace"),
        ("spectro-server", "Spring Boot 3.5", "WebSocket /ws + 12 REST endpoints · serves the built UI"),
        ("spectro-web", "React 19 + Vite", "Chat · Spectrum · Graph · Trace · Lab (Flow) · 3 brand designs"),
        ("spectro-desktop", "Electron 37", "spawns the boot jar · health poll · tray · SIGTERM/SIGKILL"),
        ("./spectro launcher", "one word to start", "resolves a JDK 21+ · loads .env · repl|web|desktop|doctor|tour"),
    ]
    yy = fy
    FH = 78
    face_mid = []
    for name, kind, sub in faces:
        b.append(C.card(face_x, yy, face_w, FH, None, accent=C.ZONE_FACE))
        b.append(C.text(face_x + 18, yy + 26, name, 15.5, C.WHITE, 700))
        b.append(C.text(face_x + face_w - 16, yy + 26, kind, 11.5, C.GREY_MID, anchor="end"))
        for i, ln in enumerate(C.wrap(sub, 12, face_w - 36)):
            b.append(C.text(face_x + 18, yy + 47 + i * 16, ln, 12, C.GREY_MID))
        face_mid.append(yy + FH / 2)
        yy += FH + 14
    # wiring between faces
    b.append(C.path_arrow(mk, f"M{face_x + face_w - 40} {face_mid[1] + 39} v14", C.ZONE_FACE))
    b.append(C.label_pill(face_x + face_w - 118, face_mid[1] + 46, "WebSocket · RunEvents", 10))
    b.append(C.path_arrow(mk, f"M{face_x + face_w - 40} {face_mid[3] - 39} v-14", C.ZONE_FACE))
    b.append(C.label_pill(face_x + face_w - 128, face_mid[3] - 46, "spawns + supervises the jar", 10))

    # ---- the stream spine (core -> faces) ------------------------------
    sx1, sx2 = core_x + core_w, face_x
    sy = (face_mid[0] + face_mid[1]) / 2  # between cli and server
    bx = sx2 - 18
    b.append(f'<path d="M{sx1} {sy} H{bx}" stroke="{C.SAND}" stroke-width="4"/>')
    # branch up to cli, down to server
    b.append(C.path_arrow(mk, f"M{bx} {sy} V{face_mid[0]} h8", C.SAND, sw=2.4))
    b.append(C.path_arrow(mk, f"M{bx} {sy} V{face_mid[1]} h8", C.SAND, sw=2.4))
    mid = (sx1 + bx) / 2 - 28
    b.append(C.text(mid, sy - 58, "RunEvent stream", 15, C.SAND, 700, anchor="middle"))
    b.append(C.text(mid, sy - 40, "18 typed events, one wire", 11, C.GREY_MID, anchor="middle"))
    for i, role in enumerate(["= UI protocol", "= JSONL storage", "= graph + Lab source"]):
        b.append(C.text(mid, sy + 26 + i * 17, role, 11.5, C.GREY_LIGHT, anchor="middle"))

    # ---- storage band (bottom, moss) ------------------------------------
    st_y = cy + core_h + 36
    st_h = 118
    b.append(C.card(PAD, st_y, W - 2 * PAD, st_h, "Disk: everything the harness persists", accent=C.ZONE_DISK))
    disk = ["~/.spectro/config.json", "~/.spectro/sessions/<id>.jsonl", "sessions/<id>/blobs/<sha256>",
            "~/.spectro/images/<sha256>.<ext>", "~/.spectro/skills/", "~/.spectro/notes/", "~/.spectro/models/ (STT/TTS)",
            "~/.spectro/jobs.json + jobs-state.json", "<project>/.spectro/settings.json", "<project>/.spectro/skills/",
            "SPECTRO.md", "./.env"]
    s, _ = C.chip_row(PAD + 16, st_y + 44, disk, W - 2 * PAD - 32, C.GREY_LIGHT, 12, fill=C.CARD_UP, stroke=C.ZONE_DISK_DEEP)
    b.append(s)
    b.append(C.arrow(mk, core_x + core_w / 2, cy + core_h, core_x + core_w / 2, st_y - 4, C.ZONE_DISK))

    # ---- stats strip -----------------------------------------------------
    n_y = st_y + st_h + 42
    stats = [("5 + 2", "Gradle modules + JS toolchains"), ("41,071", "lines of source"),
             ("545 + 310", "JUnit + vitest, 0 failures"), ("18", "RunEvent types"),
             ("19", "tools behind one gate"), ("3 + 2", "LLM + image providers"),
             ("3", "brand designs")]
    sw = (W - 2 * PAD) / len(stats)
    for i, (num, lab) in enumerate(stats):
        x = PAD + i * sw
        b.append(C.text(x, n_y + 10, num, 30, C.SAND, 300))
        for j, ln in enumerate(C.wrap(lab, 11.5, sw - 24)):
            b.append(C.text(x, n_y + 32 + j * 15, ln, 11.5, C.GREY_MID))
    b.append(C.line(PAD, n_y - 28, W - PAD, n_y - 28, C.STROKE_SOFT))

    # ---- legend + provenance --------------------------------------------
    ly = n_y + 78
    b.append(C.legend(PAD, ly, [
        (C.ZONE_CORE_DEEP, "core library", "stroke"),
        (C.ZONE_FACE, "faces", "stroke"),
        (C.ZONE_EXT, "model side / external", "stroke"),
        (C.ZONE_DISK, "disk", "stroke"),
        (C.SAND, "the event wire", "fill"),
        (C.GREY_MID, "dashed = external process", "dash"),
    ]))
    b.append(C.provenance(W, ly, "build_00_overview.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "overview")


if __name__ == "__main__":
    C.write("00-one-core-five-faces.svg", build())

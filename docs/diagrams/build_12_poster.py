#!/usr/bin/env python3
"""12 — The wall poster: every component of the full build in one picture,
including the humans, the OS, the disk and everything beyond the machine.

Source-verified against the whole spectro/ tree on 2026-07-16 (see the other
build_*.py generators for the per-area evidence).
"""

import svg_common as C

W = 2800
PAD = 56

MAC_W = 1960
EXT_X = 2140
EXT_W = W - PAD - EXT_X


def zone_label(b, x, y, s, color=C.GREY_MID):
    b.append(C.text(x, y, s.upper(), 13, color, ls="0.16em"))


def small_card(b, x, y, w, h, title, lines, accent=None, dash=None, title_size=13.5):
    b.append(C.card(x, y, w, h, None, accent=accent, dash=dash))
    b.append(C.text(x + 14, y + 24, title, title_size, C.WHITE, 700))
    for i, ln in enumerate(lines):
        b.append(C.text(x + 14, y + 44 + i * 16, ln, 10.8, C.GREY_MID, mono=True))


def build():
    mk = C.Markers("poster")
    b = []

    b.append(C.eyebrow(PAD, PAD + 6, "spectroscope · architecture dossier · 12 · the wall"))
    b.append(C.text(PAD, PAD + 64, "spectroscope, the whole machine.", 52, C.WHITE, 300, ls="-0.02em"))
    b.append(C.text(PAD, PAD + 96,
                    "Agent harness, five faces, one event wire. Everything on this wall exists in the repo; the dashed line is the real network boundary.",
                    17, C.GREY_MID))
    b.append(C.m_mark(W - 430, PAD - 60, 500, C.SAND, 0.14))
    b.append(C.line(PAD, PAD + 124, W - PAD, PAD + 124, C.STROKE_SOFT))

    top = PAD + 150
    mc = []  # machine-zone content, appended after the zone rect is sized

    # ---- humans + surfaces band -------------------------------------------
    sy = top + 48
    zone_label(mc, PAD + 20, sy + 10, "people + surfaces")
    small_card(mc, PAD + 20, sy + 20, 380, 96, "You, in a terminal",
               ["spectro repl · slash commands", "/model /skills /mcp /voice /compact"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 420, sy + 20, 420, 96, "You, in a browser tab",
               ["Chat · Graph · Trace · Lab", "127.0.0.1:8080 (or the dev proxy)"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 860, sy + 20, 420, 96, "You, in the desktop app",
               ["the same UI in an Electron window", "tray keeps cron alive on close"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 1300, sy + 20, 620, 96, "You, as the permission gate",
               ["permission_request -> dialog / [y/N] -> permission_decision",
                "checkboxes: remember (session) · persist (settings.json)"],
               accent=C.CORAL)

    # ---- faces band ---------------------------------------------------------
    fy = sy + 140
    zone_label(mc, PAD + 20, fy + 10, "faces (renderers of the stream)")
    face_y = fy + 20
    small_card(mc, PAD + 20, face_y, 370, 118, "spectro-cli",
               ["picocli: repl · run · cron · doctor", "EventRenderer (child turns dimmed)",
                "TracingProvider on --verbose", "SpeechRenderer (piper) on --speak"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 410, face_y, 400, 118, "spectro-server",
               ["Spring Boot 3.5 · SpectroSocketHandler /ws", "12 REST endpoints (replay, context,",
                "models, files, images, transcribe...)", "SessionConnection per socket"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 830, face_y, 400, 118, "spectro-web (built into the jar)",
               ["React 19 · one pure reducer -> UiState", "Lab: Flow map + stepper dam",
                "3 designs + brand dust particles", "i18n chrome DE/EN · import + scenarios"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 1250, face_y, 340, 118, "spectro-desktop",
               ["Electron supervisor: free port,", "spawn jar, poll /api/health,",
                "tray + notifications, SIGTERM"],
               accent=C.ZONE_FACE)
    small_card(mc, PAD + 1610, face_y, 310, 118, "./spectro launcher",
               ["resolves a JDK 21+", "loads ./.env for every face",
                "repl web desktop doctor tour"],
               accent=C.ZONE_FACE)

    # ---- the wire -----------------------------------------------------------
    wy = face_y + 118 + 46
    mc.append(f'<path d="M{PAD + 30} {wy} H{PAD + MAC_W - 30}" stroke="{C.SAND}" stroke-width="5" opacity="0.95"/>')
    mc.append(C.rect(PAD + 690, wy - 16, 560, 32, C.EBONY, C.SAND_DEEP, rx=16))
    mc.append(C.text(PAD + 970, wy + 5, "the RunEvent wire · 18 typed events · UI = storage = graph", 13.5,
                     C.SAND, anchor="middle"))
    for ax in (PAD + 200, PAD + 610, PAD + 1030, PAD + 1420):
        mc.append(C.arrow(mk, ax, wy - 2, ax, face_y + 118 + 8, C.SAND, sw=2))
    mc.append(C.arrow(mk, PAD + 1720, wy + 30, PAD + 1720, wy + 2, C.SAND, sw=2))

    # ---- the core band -------------------------------------------------------
    cy = wy + 26
    core_h = 420
    mc.append(C.rect(PAD + 20, cy, MAC_W - 40, core_h, C.CARD, C.ZONE_CORE_DEEP, rx=14, sw=1.4))
    mc.append(C.text(PAD + 40, cy + 34, "spectro-core", 20, C.WHITE, 700))
    mc.append(C.text(PAD + 170, cy + 34, "headless Java 21 library · plain new · virtual threads, blocking style", 12.5, C.GREY_MID))

    col_w2 = (MAC_W - 80) / 4

    def core_card(col, row, title, lines, accent=C.ZONE_CORE_DEEP):
        x = PAD + 40 + col * col_w2
        y = cy + 56 + row * 178
        small_card(mc, x, y, col_w2 - 20, 166, title, lines, accent=accent)

    core_card(0, 0, "Agent (the loop)",
              ["stream -> guard -> tool -> repeat", "runGuarded: hook, gate, execute",
               "compaction at 100k contextTokens", "context_info introspection",
               "CancelSignal cascades everywhere"])
    core_card(1, 0, "ToolRegistry · 19 tools",
              ["files: read/write/edit/list/glob/grep", "run_command · web_fetch",
               "generate_image · use_skill", "update_plan · spawn + dev tools",
               "mcp__<server>__<tool> (dynamic)"])
    core_card(2, 0, "Permission gate",
              ["PermissionBroker (blocking future)", "Allowlist: prefix rules per",
               "guardedField (command/path/url)", "HookRunner: pre blocks, post advises",
               "SettingsWriter persists, no clobber"], accent=C.CORAL)
    core_card(3, 0, "SubagentManager · A2A-lite",
              ["explore (read-only) · worker roles", "dev tools -> skill per DevSpec",
               "max 4 parallel · 120 s timeout", "agent_spawn + agent_message",
               "task/status/result lifecycle"])
    core_card(0, 1, "Providers behind the port",
              ["LlmProvider.stream()", "Switchable( Retrying( real ) )",
               "Anthropic SDK · Ollama NDJSON", "OpenAI-compat SSE", "ImageProvider: gemini | openai"],
              accent=C.ZONE_EXT_DEEP)
    core_card(1, 1, "SessionStore + blobs",
              ["append JSONL, crash-safe", "resume: structural main find",
               "blobs: sha256 attachments", "ImageStore: content-addressed",
               "byte-identical with TS edition"], accent=C.ZONE_DISK_DEEP)
    core_card(2, 1, "SkillLibrary + MCP client",
              ["SKILL.md catalog -> use_skill", "user + project roots (project wins)",
               "McpServerRegistry eager connect", "McpClient at-most-once calls",
               "stdio primary · HTTP SSE optional"])
    core_card(3, 1, "CronScheduler + Headless",
              ["cron-utils UNIX 5-field", "jobs.json -> HeadlessRunner",
               "overlap guard · JobState", "spectro run -p ... --json for scripts",
               "notifications via osascript"])

    # ---- OS + disk bands ------------------------------------------------------
    oy = cy + core_h + 24
    zone_label(mc, PAD + 20, oy + 10, "operating system (everything spectroscope shells out to)")
    os_chips = ["/bin/sh -c (run_command, hooks)", "Ollama server :11434 (local LLM)", "whisper-cli + ggml-small.bin (STT)",
                "piper (TTS)", "ffmpeg (webm -> wav)", "osascript notifications", "JDK 21+ (launcher-resolved)",
                "MCP child processes (spectro-mcp-notes)"]
    s, os_end = C.chip_row(PAD + 20, oy + 22, os_chips, MAC_W - 60, C.GREY_LIGHT, 12, fill=C.CARD_UP, stroke=C.STROKE)
    mc.append(s)

    dy = os_end + 22
    zone_label(mc, PAD + 20, dy + 10, "disk")
    disk_chips = ["~/.spectro/config.json", "~/.spectro/sessions/<id>.jsonl", "sessions/<id>/blobs/", "~/.spectro/images/",
                  "~/.spectro/skills/", "~/.spectro/notes/", "~/.spectro/models/", "~/.spectro/jobs.json",
                  "<project>/.spectro/settings.json", "<project>/.spectro/skills/", "SPECTRO.md", "./.env",
                  "jar!/static/ (the built UI)"]
    s, disk_end = C.chip_row(PAD + 20, dy + 22, disk_chips, MAC_W - 60, C.GREY_LIGHT, 12,
                             fill=C.CARD_UP, stroke=C.ZONE_DISK_DEEP)
    mc.append(s)

    # gate line: from the gate surface card, through the face-band gap, into the core gate card
    gx = PAD + 1600
    gate_cc = PAD + 40 + 2 * col_w2 + (col_w2 - 20) / 2
    mc.append(C.path_arrow(mk, f"M{gx} {sy + 116} V{cy + 46} H{gate_cc} V{cy + 52}",
                           C.CORAL, dash="6 4", sw=1.6))

    # ---- the machine zone, sized to its content ------------------------------
    mac_h = disk_end + 24 - top
    b.append(C.rect(PAD, top, MAC_W, mac_h, C.CARD_SOFT, C.STROKE, rx=16))
    zone_label(b, PAD + 20, top + 30, "your machine", C.GREY_LIGHT)
    b.extend(mc)

    # ================= beyond the machine ====================================
    bx = EXT_X
    b.append(C.line(bx - 60, top, bx - 60, top + mac_h, C.CORAL, 1.6, dash="10 7"))
    lab_y = top + mac_h - 200
    b.append(f'<text x="{bx - 84}" y="{lab_y}" fill="{C.CORAL}" font-size="13" '
             f'font-family="{C.FONT}" letter-spacing="0.16em" text-anchor="middle" '
             f'transform="rotate(-90 {bx - 84} {lab_y})">THE NETWORK BOUNDARY</text>')
    zone_label(b, bx, top + 30, "beyond the machine", C.GREY_LIGHT)
    ext_cards = [
        ("Anthropic API", ["api.anthropic.com · SSE stream", "prompt caching · extended thinking", "ANTHROPIC_API_KEY"], C.ZONE_EXT),
        ("OpenAI-compatible endpoint", ["/v1/chat/completions · SSE", "any host: LM Studio, vLLM, cloud", "key optional"], C.ZONE_EXT),
        ("Gemini image API", ["generateContent · x-goog-api-key", "gemini-2.5-flash-image"], C.ZONE_EXT),
        ("OpenAI image API", ["/v1/images/generations · Bearer", "gpt-image-1 · 1024x1024 png"], C.ZONE_EXT),
        ("web_fetch targets", ["any http(s) page, gated,", "streamed + capped at 512 kB"], C.CORAL),
        ("MCP over HTTP + SSE", ["optional remote MCP servers", "(stdio siblings live on the Mac)"], C.ZONE_EXT),
        ("Model downloads (setup)", ["Hugging Face: ggml-small.bin", "GitHub: piper + voices", "SHA256-pinned, one-time"], C.ZONE_DISK),
    ]
    ey = top + 48
    ext_pos = {}
    for title, lines, accent in ext_cards:
        h = 40 + len(lines) * 16 + 12
        small_card(b, bx, ey, EXT_W, h, title, lines, accent=accent,
                   dash="6 4" if "MCP over" in title else None)
        ext_pos[title] = ey + h / 2
        ey += h + 16

    # crossing stubs, orthogonal through the empty corridor
    prov_y = cy + 56 + 178 + 83
    tools_y = cy + 56 + 83
    b.append(C.path_arrow(mk, f"M{PAD + MAC_W} {prov_y} H{bx - 96} V{ext_pos['Anthropic API']} H{bx - 6}",
                          C.ZONE_EXT, sw=1.6))
    b.append(C.path_arrow(mk, f"M{PAD + MAC_W} {tools_y} H{bx - 116} V{ext_pos['web_fetch targets']} H{bx - 6}",
                          C.CORAL, sw=1.4, dash="6 4"))

    # ================= stats + legend =========================================
    ny = top + mac_h + 46
    stats = [("4 + 2", "modules + JS toolchains"), ("41,071", "lines of source"),
             ("348 + 244", "JUnit + vitest, green"), ("18", "RunEvent types"),
             ("19", "tools"), ("12", "REST endpoints"), ("6 + 3", "WS frame types + designs"),
             ("7", "teaching scenarios"), ("3 + 2 + 2", "LLM + image + voice engines"),
             ("16", "workshop stages (0-9 + b1-b6)")]
    sw2 = (W - 2 * PAD) / len(stats)
    for i, (num, lab) in enumerate(stats):
        x = PAD + i * sw2
        b.append(C.text(x, ny + 16, num, 32, C.SAND, 300))
        for j, ln in enumerate(C.wrap(lab, 12, sw2 - 26)):
            b.append(C.text(x, ny + 40 + j * 16, ln, 12, C.GREY_MID))

    ly = ny + 92
    b.append(C.legend(PAD, ly, [
        (C.ZONE_FACE, "faces + surfaces", "stroke"),
        (C.ZONE_CORE_DEEP, "core", "stroke"),
        (C.ZONE_EXT, "external service", "stroke"),
        (C.ZONE_DISK_DEEP, "disk", "stroke"),
        (C.SAND, "the event wire", "fill"),
        (C.CORAL, "human decision / network boundary", "dash"),
    ]))
    b.append(C.provenance(W, ly, "build_12_poster.py"))
    return C.doc(W, ly + 30, f"<defs>{mk.defs()}</defs>" + "".join(b), "poster")


if __name__ == "__main__":
    C.write("12-the-wall.svg", build())

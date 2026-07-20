#!/usr/bin/env python3
"""01 — The build: Gradle modules, JS toolchains, and who depends on whom.

Source-verified against settings.gradle.kts, every */build.gradle.kts,
gradle/libs.versions.toml and spectro-web/vite.config.ts on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56
CARD_W, CARD_H = 500, 240

MODULES = [
    # (name, kind, zone, facts, loc_badge, col, row)  -- core sits center
    ("spectro-cli", "application · terminal face", C.ZONE_FACE_DEEP, [
        "mainClass dev.spectroscope.cli.SpectroCli (picocli)",
        "runtimeOnly slf4j-nop (kills logger noise)",
        "subcommands: run · cron · doctor (+ repl default)",
        "EventRenderer · TracingProvider · Tour",
        "voice: Transcriber (whisper-cli) · SpeechRenderer",
    ], "3,177 LOC · 33 JUnit", 0, 0),
    ("spectro-core", "java-library · the headless harness", C.ZONE_CORE_DEEP, [
        "api jackson-databind (the wire)",
        "impl anthropic-java · spring-web (RestClient)",
        "impl cron-utils · spring-context/aop",
        "no Spring Boot, no component scan",
        "key types: Agent · EventStream · LlmProvider ·",
        "ToolRegistry · PermissionBroker · SessionStore",
    ], "7,633 LOC · 267 JUnit", 1, 0),
    ("spectro-server", "Spring Boot 3.5.3 · web backend", C.ZONE_FACE_DEEP, [
        "starter-web + starter-websocket",
        "depends on :spectro-core AND :spectro-cli",
        "(reuses dev.spectroscope.cli.voice.Transcriber)",
        "SpectroSocketHandler /ws · 5 REST controllers",
        "serves classpath:/static (the built web UI)",
    ], "1,346 LOC · 30 JUnit", 2, 0),
    ("spectro-mcp-notes", "application · example MCP server", C.ZONE_EXT_DEEP, [
        "mainClass dev.spectroscope.mcp.notes.NotesServer",
        "jackson-databind only · no MCP SDK, no Lucene",
        "stdio JSON-RPC 2.0 · one line in, one line out",
        "tools: search_notes · add_note",
        "storage: ~/.spectro/notes (one file per note)",
    ], "496 LOC · 18 JUnit", 0, 1),
    ("spectro-web", "Vite 6 + React 19 · browser face", C.ZONE_FACE_DEEP, [
        "TypeScript 5.8 · @xyflow/react 12 · dagre 0.8",
        "build.outDir = ../spectro-server/.../static",
        "dev proxy: /api + /ws to :8080",
        "not a Gradle module: its own toolchain on purpose",
        "(business reality: Java backend, JS frontend)",
    ], "12,249 LOC + 4,554 css · 244 vitest", 1, 1),
    ("spectro-desktop", "Electron 37 · desktop shell", C.ZONE_FACE_DEEP, [
        "src/main.ts, compiled by tsc · electron-builder",
        "supervises the spectro-server boot jar (child JVM)",
        "extraResources: spectro-server-0.0.1.jar",
        "contextIsolation on · no nodeIntegration",
        "not a Gradle module either",
    ], "222 LOC main.ts", 2, 1),
]

CATALOG = [
    "anthropic-java 2.34.0", "jackson 2.17.2", "picocli 4.7.6",
    "spring 6.2.8", "spring-boot 3.5.3", "cron-utils 9.2.1",
    "junit 5.10.2", "slf4j-nop 2.0.16", "vite 6", "react 19",
    "typescript 5.8", "@xyflow/react 12", "dagre 0.8", "electron 37",
]


def build():
    mk = C.Markers("modules")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 01",
        "The build.",
        "settings.gradle.kts includes exactly four JVM modules; spectro-web and spectro-desktop live "
        "beside the Gradle build with their own toolchains. Java 21 everywhere, tests run against build/test-home.")
    b.append(head)

    gap_x = (W - 2 * PAD - 3 * CARD_W) / 2
    col_x = [PAD, PAD + CARD_W + gap_x, PAD + 2 * (CARD_W + gap_x)]
    ROW_GAP = 110
    row_y = [y0 + 26, y0 + 26 + CARD_H + ROW_GAP]

    pos = {}
    for name, kind, zone, facts, badge, col, row in MODULES:
        x, y = col_x[col], row_y[row]
        b.append(C.card(x, y, CARD_W, CARD_H, None, accent=zone))
        b.append(C.text(x + 18, y + 30, name, 17, C.WHITE, 700))
        b.append(C.text(x + 18, y + 50, kind, 12.5, C.GREY_MID))
        for i, f in enumerate(facts):
            b.append(C.text(x + 18, y + 76 + i * 19, f, 12, C.GREY_LIGHT, mono=True))
        b.append(C.rect(x + 18, y + CARD_H - 34, C.est_w(badge, 11.5, True) + 20, 22,
                        C.CARD_UP, C.STROKE, rx=11))
        b.append(C.text(x + 28, y + CARD_H - 19, badge, 11.5, C.GREY_MID, mono=True))
        pos[name] = (x, y)

    cli, core, srv = pos["spectro-cli"], pos["spectro-core"], pos["spectro-server"]
    notes, web, desk = pos["spectro-mcp-notes"], pos["spectro-web"], pos["spectro-desktop"]
    mid_y0 = row_y[0] + CARD_H / 2
    gap_mid_l = (col_x[0] + CARD_W + col_x[1]) / 2
    gap_mid_r = (col_x[1] + CARD_W + col_x[2]) / 2

    # cli -> core, server -> core (one gap each)
    b.append(C.arrow(mk, cli[0] + CARD_W, mid_y0 - 46, core[0] - 6, mid_y0 - 46, C.ZONE_CORE))
    b.append(C.label_pill(gap_mid_l, mid_y0 - 64, "impl"))
    b.append(C.arrow(mk, srv[0], mid_y0 - 46, core[0] + CARD_W + 6, mid_y0 - 46, C.ZONE_CORE))
    b.append(C.label_pill(gap_mid_r, mid_y0 - 64, "impl"))
    # server -> cli, routed underneath row 1
    dip = row_y[0] + CARD_H + 34
    b.append(C.path_arrow(
        mk, f"M{srv[0] + 90} {row_y[0] + CARD_H} V{dip} H{cli[0] + 90} V{row_y[0] + CARD_H + 6}",
        C.ZONE_CORE))
    b.append(C.label_pill(col_x[1] + CARD_W / 2, dip, "implementation (reuses the cli Transcriber)"))
    # web ==> server static/ (build artifact)
    b.append(C.path_arrow(
        mk, f"M{web[0] + CARD_W} {web[1] + 60} C {gap_mid_r} {web[1] + 60}, {gap_mid_r} {row_y[0] + CARD_H + 74}, "
            f"{srv[0] + CARD_W - 60} {row_y[0] + CARD_H + 8}",
        C.SAND, sw=2.2))
    b.append(C.label_pill(gap_mid_r + 150, row_y[1] - 52, "vite build writes static/", 11, C.SAND))
    # desktop --> server (runtime spawn)
    b.append(C.path_arrow(mk, f"M{desk[0] + CARD_W / 2} {desk[1]} V{row_y[0] + CARD_H + 8}",
                          C.ZONE_FACE, dash="6 4"))
    b.append(C.label_pill(desk[0] + CARD_W / 2 + 60, desk[1] - 18, "spawns java -jar spectro-server.jar", 11))
    # notes --> core (runtime stdio)
    b.append(C.path_arrow(
        mk, f"M{notes[0] + CARD_W / 2} {notes[1]} C {notes[0] + CARD_W / 2} {notes[1] - 54}, "
            f"{core[0] + 60} {row_y[0] + CARD_H + 60}, {core[0] + 110} {row_y[0] + CARD_H + 8}",
        C.ZONE_EXT, dash="6 4"))
    b.append(C.label_pill(notes[0] + CARD_W / 2 + 60, notes[1] - 58, "stdio JSON-RPC at runtime", 11))

    # version catalog band
    vy = row_y[1] + CARD_H + 64
    b.append(C.text(PAD, vy - 14, "VERSION CATALOG (gradle/libs.versions.toml) + JS TOOLCHAIN", 12, C.GREY_MID, ls="0.12em"))
    s, ny = C.chip_row(PAD, vy, CATALOG, W - 2 * PAD, C.GREY_LIGHT, 12)
    b.append(s)

    ly = ny + 44
    b.append(C.legend(PAD, ly, [
        (C.ZONE_CORE, "impl = implementation dependency", "stroke"),
        (C.SAND, "build artifact flow", "fill"),
        (C.GREY_MID, "dashed = runtime process link", "dash"),
    ]))
    b.append(C.provenance(W, ly, "build_01_modules.py"))
    return C.doc(W, ly + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "modules")


if __name__ == "__main__":
    C.write("01-gradle-modules.svg", build())

#!/usr/bin/env python3
"""09 — Start it: the ./spectro launcher, the desktop supervisor, the doctor.

Source-verified against spectro/spectroscope (bash), spectro-desktop/src/main.ts,
spectro-cli DoctorCommand and scripts/setup-*.sh on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

COMMANDS = [
    ("repl", ":spectro-cli:run"),
    ("run / cron / sessions", ":spectro-cli:run run|cron|sessions"),
    ("resume <id>", ":spectro-cli:run --resume <id>"),
    ("doctor", ":spectro-cli:run doctor"),
    ("tour", "gradle tour (guided menu)"),
    ("web", ":spectro-server:bootRun"),
    ("desktop", "bootJar + Electron (below)"),
    ("mcp-notes", ":spectro-mcp-notes:installDist"),
]

DESKTOP = [
    ("0", "./spectro desktop first stops any stale instance", "pgrep/pkill electron + old jar (single-instance lock handoff)"),
    ("1", "build the jar, prep Electron", "gradlew :spectro-server:bootJar · first run: npm install + clear com.apple.quarantine"),
    ("2", "Electron main.ts starts", "requestSingleInstanceLock() · app menu + tray (inline diamond icon)"),
    ("3", "findFreePort()", "bind 127.0.0.1:0, read the assigned port"),
    ("4", "spawn the JVM", "spawn(java, [-jar, spectro-server.jar, --server.port=P]) · ENOENT -> Java 21 dialog"),
    ("5", "wait for health", "GET /api/health every 500 ms, 30 s budget; failure -> shutdown + dialog"),
    ("6", "open the window", "BrowserWindow 1200x800 · loadURL(127.0.0.1:P) · contextIsolation, no nodeIntegration"),
    ("7", "live", "tray: New chat · Cron status · Quit · window close keeps the JVM (cron runs on) · jobs poll 30 s -> native notifications"),
    ("8", "quit", "before-quit -> SIGTERM (Boot graceful), SIGKILL after 5 s grace"),
]

DOCTOR = [
    "1  Java version >= 21",
    "2  config layers + effective provider/model",
    "3  provider reachability (key / probe)",
    "4  image provider keys (info only)",
    "5  skills: count + names",
    "6  hooks: count + event:matcher",
    "7  MCP servers: reachability + tool count",
    "8  vision hint (ollama needs a vision model)",
    "9  voice input: whisper-cli + ggml-small.bin",
    "10 voice output: piper + en_US-lessac voice",
    "11 sessions dir writable + count",
    "12 jobs.json valid + job count",
]


def build():
    mk = C.Markers("runtime")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 09",
        "Start it: launcher, desktop, doctor.",
        "One executable per checkout fixes the two host problems (JDK version, .env) before any command runs. "
        "The desktop face is a supervisor: Electron manages the Spring Boot JVM as a child process.")
    b.append(head)

    top = y0 + 10
    # ---- left: launcher ---------------------------------------------------
    lx, lw = PAD, 480
    b.append(C.card(lx, top, lw, 88, "./spectro <task>", accent=C.ZONE_FACE))
    b.append(C.text(lx + 16, top + 48, "137 lines of bash · dispatches the spectroscope tasks,", 11.8, C.GREY_MID, mono=True))
    b.append(C.text(lx + 16, top + 66, "not the raw Gradle task zoo", 11.8, C.GREY_MID, mono=True))

    cy = top + 88 + 18
    ch = 44 + len(COMMANDS) * 27 + 6
    b.append(C.card(lx, cy, lw, ch, "Commands", accent=C.ZONE_FACE))
    yy = cy + 48
    for cmd, target in COMMANDS:
        b.append(C.text(lx + 16, yy, cmd, 12, C.GREY_LIGHT, mono=True))
        b.append(C.text(lx + 210, yy, target, 11, C.GREY_MID, mono=True))
        yy += 27

    py = cy + ch + 18
    b.append(C.card(lx, py, lw, 168, "Pre-flight, before every task", accent=C.SAND))
    pf = [
        "JDK: keep a good JAVA_HOME, else probe",
        "java_home -v 21, brew openjdk@21 keg,",
        "openjdk@25/23/22/24, Cellar globs",
        "(prefers the stable versioned keg)",
        ".env: skip comments/blanks, strip quotes,",
        "export non-empty values - for EVERY face",
    ]
    for i, ln in enumerate(pf):
        b.append(C.text(lx + 16, py + 46 + i * 20, ln, 11.5, C.GREY_MID, mono=True))

    # ---- middle: desktop sequence ------------------------------------------
    mx, mw = lx + lw + 56, 620
    b.append(C.text(mx, top + 4, "THE DESKTOP SUPERVISOR (spectro-desktop/src/main.ts, 222 LOC)", 12, C.GREY_MID, ls="0.12em"))
    dy = top + 18
    for num, title, sub in DESKTOP:
        subs = C.wrap(sub, 10.8, mw - 70, mono=True)
        h = 26 + len(subs) * 15 + 8
        b.append(C.rect(mx, dy, mw, h, C.CARD, C.STROKE, rx=9))
        b.append(C.circle(mx + 22, dy + h / 2, 11, C.CARD_UP, C.ZONE_FACE_DEEP, 1.4))
        b.append(C.text(mx + 22, dy + h / 2 + 4, num, 11, C.GREY_LIGHT, anchor="middle", mono=True))
        b.append(C.text(mx + 44, dy + 19, title, 12.5, C.WHITE, 700))
        for i, ln in enumerate(subs):
            b.append(C.text(mx + 44, dy + 37 + i * 15, ln, 10.8, C.GREY_MID, mono=True))
        dy += h + 8

    # ---- right: doctor + setup scripts --------------------------------------
    rx = mx + mw + 56
    rw = W - PAD - rx
    dh = 44 + len(DOCTOR) * 24 + 10
    b.append(C.card(rx, top, rw, dh, "spectro doctor (12 checks)", accent=C.ZONE_CORE))
    yy = top + 48
    for ln in DOCTOR:
        b.append(C.text(rx + 16, yy, ln, 11.3, C.GREY_MID, mono=True))
        yy += 24
    b.append(C.text(rx + 16, yy + 2, "any red check -> exit non-zero", 11, C.GREY_DIM, mono=True))

    sy = top + dh + 18
    b.append(C.card(rx, sy, rw, 170, "Voice setup scripts", accent=C.ZONE_DISK))
    vs = [
        "scripts/setup-stt.sh: whisper-cpp +",
        "ffmpeg (brew), downloads ggml-small.bin",
        "(SHA256-pinned) to ~/.spectro/models/",
        "scripts/setup-tts.sh: piper binary +",
        "en_US-lessac-medium voice to",
        "~/.spectro/models/piper/ · both idempotent",
    ]
    for i, ln in enumerate(vs):
        b.append(C.text(rx + 16, sy + 46 + i * 20, ln, 11.3, C.GREY_MID, mono=True))

    bottom = max(py + 168, dy, sy + 170) + 40
    b.append(C.legend(PAD, bottom, [
        (C.ZONE_FACE, "launcher / shell", "stroke"),
        (C.ZONE_FACE_DEEP, "Electron supervisor step", "stroke"),
        (C.ZONE_CORE, "diagnostics", "stroke"),
        (C.SAND, "host fixes (JDK, .env)", "stroke"),
    ]))
    b.append(C.provenance(W, bottom, "build_09_runtime.py"))
    return C.doc(W, bottom + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "runtime")


if __name__ == "__main__":
    C.write("09-launcher-desktop.svg", build())

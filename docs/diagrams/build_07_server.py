#!/usr/bin/env python3
"""07 — spectro-server: one socket, twelve REST endpoints, one connection object.

Source-verified against spectro-server/src/main/java/spectroscope/server/* on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56

WS_IN = [
    ("user_message", "text + optional attachments[{mediaType, dataBase64}]"),
    ("permission_response", "callId · allowed · remember (session) · persist (settings.json)"),
    ("abort", "cancels the running CancelSignal"),
    ("set_provider", "provider + model · SwitchableProvider.swap, key-checked"),
    ("set_thinking", "on/off, applies on the next run"),
    ("set_image_provider", "gemini | openai, applies on the next generation"),
]

REST = [
    ("GET", "/api/health", "desktop shell readiness probe: {status: ok}"),
    ("GET", "/api/sessions", "sidebar list (id, startedAt, firstPrompt, tokens, provider)"),
    ("GET", "/api/sessions/{id}/events", "full replay source, every stored RunEvent"),
    ("GET", "/api/config", "boot provider + model (initial header truth)"),
    ("GET", "/api/context", "what the LLM sees before message one (ContextDescriber)"),
    ("GET", "/api/models?provider=", "ollama LIVE via /api/tags probe (1.5s/2.5s timeouts) · cloud curated"),
    ("GET", "/api/images/{file}", "generated image bytes · name must match [0-9a-f]{64}.(png|jpg|webp)"),
    ("GET", "/api/jobs/state", "cron job states, polled by the desktop tray (30 s)"),
    ("GET", "/api/files", "sandboxed cwd tree · depth 8 · 2000 entries · honest truncated flag"),
    ("GET", "/api/file?path=", "one file for preview · CSP sandbox allow-scripts · 413/415 guards"),
    ("GET", "/api/claude/transcripts", "~/.claude/projects *.jsonl list (Finder-invisible), cap 300"),
    ("POST", "/api/transcribe", "webm -> ffmpeg 16k wav -> whisper-cli · 503 + setup hint if absent"),
]


def build():
    mk = C.Markers("server")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 07",
        "The web backend.",
        "Spring Boot on 127.0.0.1:8080. One TextWebSocketHandler speaks the RunEvent wire; a handful of "
        "read-only REST endpoints serve replay, context, models and the workspace. One jar serves the built UI.")
    b.append(head)

    top = y0 + 10
    # left: websocket
    lx, lw = PAD, 640
    b.append(C.card(lx, top, lw, 96, "WebSocket /ws", accent=C.ZONE_FACE))
    b.append(C.text(lx + 16, top + 48, "SpectroSocketHandler · one SessionConnection per socket · origins * · 16 MiB frames",
                    11.8, C.GREY_MID, mono=True))
    b.append(C.text(lx + 16, top + 68, "?resume=<id> reopens a stored JSONL session · server -> client = the RunEvent wire",
                    11.8, C.GREY_MID, mono=True))

    ty = top + 96 + 20
    b.append(C.text(lx, ty + 6, "CLIENT TO SERVER FRAMES", 12, C.GREY_MID, ls="0.12em"))
    ty += 18
    for name, desc in WS_IN:
        b.append(C.rect(lx, ty, lw, 44, C.CARD, C.STROKE, rx=9))
        b.append(C.text(lx + 14, ty + 19, name, 13, C.GREY_LIGHT, mono=True))
        b.append(C.text(lx + 14, ty + 35, desc, 10.8, C.GREY_MID, mono=True))
        ty += 50

    ty += 16
    conn_h = 320
    b.append(C.card(lx, ty, lw, conn_h, "SessionConnection (the heart of the face)", accent=C.ZONE_CORE))
    conn = [
        "agent built ONCE per connection (multi-turn history) around a",
        "SwitchableProvider · each run on a virtual thread spectroscope-run",
        "send() synchronized: one writer per socket · store.append(event)",
        "+ send(event) get the same object (file = wire)",
        "system prompt = BASE + cwd + SPECTRO.md + skills catalog",
        "tools: StandardTools + web_fetch + generate_image + update_plan",
        "+ use_skill + spawn/dev + mcp__... (registry per connection)",
        "PermissionBroker parks a CompletableFuture per callId;",
        "remember -> session rules · persist -> SettingsWriter appends",
        "attachments: 5 MiB cap, saved to blobs BEFORE the run",
        "onClose: abort + release futures + mcp.close()",
    ]
    for i, ln in enumerate(conn):
        b.append(C.text(lx + 16, ty + 48 + i * 23, ln, 11.5, C.GREY_MID, mono=True))

    # right: REST table
    rx = lx + lw + 56
    rw = W - PAD - rx
    b.append(C.text(rx, top + 6, "REST (read-only except transcribe)", 12, C.GREY_MID, ls="0.12em"))
    ry = top + 18
    for method, path, desc in REST:
        b.append(C.rect(rx, ry, rw, 46, C.CARD, C.STROKE, rx=9))
        mcol = C.ZONE_DISK if method == "GET" else C.CORAL
        b.append(C.rect(rx + 10, ry + 9, 44, 18, C.EBONY, mcol, rx=9, sw=1.1))
        b.append(C.text(rx + 32, ry + 22, method, 10, C.GREY_LIGHT, anchor="middle", mono=True))
        b.append(C.text(rx + 64, ry + 22, path, 12.5, C.GREY_LIGHT, mono=True))
        b.append(C.text(rx + 64, ry + 39, desc, 10.5, C.GREY_MID, mono=True))
        ry += 52

    ry += 14
    b.append(C.card(rx, ry, rw, 122, "Serving + guardrails", accent=C.ZONE_FACE))
    sg = [
        "static UI from classpath:/static (vite build output) · no auth,",
        "no TLS: localhost-only by design (server.address=127.0.0.1)",
        "workspace: dotfiles + .git/build/node_modules/... refused by",
        "URL too · binary 415 · oversized 413 · realpath jail everywhere",
    ]
    for i, ln in enumerate(sg):
        b.append(C.text(rx + 16, ry + 46 + i * 19, ln, 11.5, C.GREY_MID, mono=True))

    bottom = max(ty + conn_h, ry + 122) + 40
    b.append(C.legend(PAD, bottom, [
        (C.ZONE_FACE, "transport", "stroke"),
        (C.ZONE_CORE, "core wiring", "stroke"),
        (C.ZONE_DISK, "GET (read-only)", "stroke"),
        (C.CORAL, "POST / decision", "stroke"),
    ]))
    b.append(C.provenance(W, bottom, "build_07_server.py"))
    return C.doc(W, bottom + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "server")


if __name__ == "__main__":
    C.write("07-spectro-server.svg", build())

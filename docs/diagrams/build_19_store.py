#!/usr/bin/env python3
"""19 — The local store: what is on disk, and which file wins.

Two questions this suite never answered in one picture. What does spectroscope
actually write into a home, and when four files all set `provider`, which one
does the run use.

Read off:
  spectro-core/.../config/SpectroConfig.java   the layer order and the file names
  spectro-core/.../session/SessionStore.java   the sessions dir
  spectro-core/.../local/LocalModel.java       the models dir
  spectro-core/.../leveling/LevelingStore.java the ladder's state file
  and a real home used for the guide captures, listed after a run.

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import svg_common as C

W = 1680
PAD = 56

# Lowest first. The comment is why that rank makes sense, not a restatement.
LAYERS = [
    ("defaults", "compiled in", "the shipped answer for every key", C.GREY_MID),
    ("environment", "SPECTRO_*", "the base above defaults — a launcher's opinion", C.ZONE_DISK),
    ("user settings", "~/.spectro/settings.json", "your machine, every project", C.ZONE_FACE),
    ("launch-dir settings", "<launch dir>/.spectro/settings.json",
     "deprecated compat layer, still read", C.GREY_MID),
    ("workspace project", "<workspace>/.spectro/settings.json",
     "travels with the repo — team conventions", C.ZONE_CORE),
    ("workspace local", "<workspace>/.spectro/settings.local.json",
     "machine-local, gitignored on first write", C.ZONE_CORE),
    ("flags", "--provider, --model, …", "this one invocation, nothing else", C.CORAL),
]

# What a home holds after the captures for this guide were taken.
FILES = [
    ("settings.json", "provider, model, permissionMode, mcpServers, hooks …", C.ZONE_FACE),
    (".env", "API keys ONLY, written 0600 when you save one in the UI", C.ZONE_EXT),
    ("sessions/*.jsonl", "one append-only event file per session — the archive", C.LILAC),
    ("sessions/<id>/blobs/", "attachment bytes, file name = sha256", C.LILAC),
    ("images/<sha256>.png", "generated images, shared across sessions", C.LILAC),
    ("leveling.json", "the ladder's marks, receipts and mode", C.MOSS),
    ("skills/ + .seeded", "user-scope skills; the ledger keeps your edits", C.ZONE_CORE),
    ("models/", "the built-in GGUF, and the whisper/piper voice models", C.ZONE_DISK),
    ("logs/spectroscope.log", "operator diagnostics, prefixed per agent", C.ZONE_DISK),
    ("notes/, jobs.json", "the example MCP server's store; cron jobs + state", C.GREY_MID),
]


def layer_row(x, y, w, i, name, path, why, accent):
    """One rung of the precedence ladder, indented so higher reads as higher."""
    h = 46
    out = [C.card(x, y, w, h, accent=accent)]
    out.append(C.text(x + 20, y + 28, f"{i}", 12, C.GREY_DIM, mono=True))
    out.append(C.text(x + 44, y + 21, name, 15, C.WHITE, weight=600))
    out.append(C.text(x + 44, y + 38, why, 12, C.GREY_MID))
    out.append(C.text(x + w - 20, y + 29, path, 12, C.GREY_LIGHT, mono=True, anchor="end"))
    return "".join(out), h


def file_row(x, y, w, name, what, accent):
    h = 42
    out = [C.card(x, y, w, h, accent=accent)]
    out.append(C.text(x + 20, y + 19, name, 13.5, C.WHITE, mono=True))
    out.append(C.text(x + 20, y + 35, what, 12, C.GREY_MID))
    return "".join(out), h


def build():
    head, y = C.header(
        W, "the local store", "~/.spectro",
        "plain files, no database — and a strict order for who wins")
    body = [head]
    y += 20

    col_w = (W - 2 * PAD - 30) / 2
    left_x, right_x = PAD, PAD + col_w + 30
    top = y

    body.append(C.text(left_x, y, "WHAT IS ON DISK", 12, C.GREY_DIM, mono=True))
    y += 20
    for name, what, accent in FILES:
        chunk, h = file_row(left_x, y, col_w, name, what, accent)
        body.append(chunk)
        y += h + 8
    left_bottom = y

    y = top
    body.append(C.text(right_x, y, "WHICH FILE WINS  ·  LOWEST FIRST", 12, C.GREY_DIM, mono=True))
    y += 20
    indent = 13
    for i, (name, path, why, accent) in enumerate(LAYERS):
        chunk, h = layer_row(right_x + i * indent, y, col_w - i * indent,
                             i + 1, name, path, why, accent)
        body.append(chunk)
        y += h + 10
    y += 6
    for row in ["A later layer overrides a key it sets and leaves the rest alone,",
                "so a workspace can pin one model without inheriting anything else.",
                "Keys are the exception: they are read from the environment or from",
                "~/.spectro/.env, and never from a settings file at any layer."]:
        body.append(C.text(right_x, y, row, 12.5, C.GREY_MID))
        y += 20

    y = max(left_bottom, y) + 14
    for row in ["Everything here is line-oriented text you can read, diff, back up and delete. A session file is never",
                "rewritten — not by resume, not by compaction — so one write per event is the whole durability story,",
                "and a torn last line after a crash is discarded on read."]:
        body.append(C.text(PAD, y, row, 13, C.GREY_MID))
        y += 21

    height = y + 48
    body.append(C.provenance(W, height - 22, "build_19_store.py"))
    C.write("19-store.svg", C.doc(W, height, "".join(body), "19-store"))


if __name__ == "__main__":
    build()

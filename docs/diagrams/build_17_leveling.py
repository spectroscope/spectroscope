#!/usr/bin/env python3
"""17 — The ladder: seven states, and what each one opens.

The leveling wave as one picture: an ascending staircase, one tread per state,
each carrying the spectral line it adds to the header strip, the criteria that
leave it, and the surfaces it opens.

Generated from spectro-core/src/main/resources/leveling/levels.json, which is
the same file the engine, the web UI and `spectro level` read. Nothing here is
hand-maintained copy: change a criterion in that file and re-run this script,
and the poster follows. That is the point of the card — a poster that can drift
from the product is worse than no poster.

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import json
import pathlib

import svg_common as C

W = 1680
PAD = 56

LADDER = (pathlib.Path(__file__).resolve().parents[2]
          / "spectro-core/src/main/resources/leveling/levels.json")

# The five spectral lines a climber collects, in ladder order. Same five as the
# logo, same order; the sixth tread holds all of them at once.
LINES = [C.CORAL, C.MOSS, C.BLOSSOM, C.LILAC, C.OCEAN]


def load():
    """The ladder as the product sees it."""
    data = json.loads(LADDER.read_text(encoding="utf-8"))
    by_level: dict[int, list[dict]] = {}
    for crit in data["criteria"]:
        by_level.setdefault(crit["level"], []).append(crit)
    return data["levels"], by_level


def strip(x, y, filled, w=13, h=7, gap=4):
    """The header pill's six-slot spectrum at a given level."""
    out = []
    for slot in range(6):
        cx = x + slot * (w + gap)
        if slot == 5:
            if filled >= 6:
                seg = w / 5
                for i, col in enumerate(LINES):
                    out.append(C.rect(cx + i * seg, y, seg + 0.4, h, col, rx=0))
            else:
                out.append(C.rect(cx, y + 2.5, w, h - 5, C.STROKE, rx=1))
        elif slot < filled:
            out.append(C.rect(cx, y, w, h, LINES[slot], rx=1.5))
        else:
            out.append(C.rect(cx, y + 2.5, w, h - 5, C.STROKE, rx=1))
    return "".join(out)


def tread(x, y, w, level, criteria, accent):
    """One state: its name, what it opens, and the criteria that leave it."""
    h = 118
    out = [C.card(x, y, w, h, accent=accent)]
    out.append(C.text(x + 22, y + 33, f"L{level['index']}", 13,
                      C.GREY_DIM, mono=True))
    out.append(C.text(x + 58, y + 34, level["id"].replace("-", " "), 21,
                      C.WHITE, weight=600))
    out.append(strip(x + w - 130, y + 26, level["index"]))

    opens = " · ".join(level["opens"])
    out.append(C.text(x + 58, y + 58, "opens " + opens, 13, C.GREY_MID))

    gating = [c["id"] for c in criteria if not c["mastery"]]
    mastery = [c["id"] for c in criteria if c["mastery"]]
    if gating:
        out.append(C.text(x + 22, y + 88, "leave when", 11, C.GREY_DIM, mono=True))
        chips, _ = C.chip_row(x + 110, y + 78, gating, w - 140, color=accent, size=12)
        out.append(chips)
    if mastery:
        out.append(C.text(x + 22, y + 88, "mastery", 11, C.GREY_DIM, mono=True))
        chips, _ = C.chip_row(x + 110, y + 78, mastery, w - 140, color=C.GREY_MID, size=12)
        out.append(chips)
    return "".join(out), h


def build():
    levels, by_level = load()
    head, y = C.header(W, "leveling", "the ladder",
                       "seven states, and the surfaces each one opens")
    body = [head]
    y += 24
    # The staircase reads bottom-up in the product and top-down on a page, so the
    # tread indents instead of climbing: the eye still walks it in reading order.
    step = 46
    card_w = W - 2 * PAD - step * 6
    for level in levels:
        accent = LINES[level["index"] - 1] if 0 < level["index"] <= 5 else (
            C.SAND if level["index"] == 6 else C.GREY_MID)
        chunk, h = tread(PAD + level["index"] * step, y, card_w,
                         level, by_level.get(level["index"], []), accent)
        body.append(chunk)
        y += h + 14

    y += 8
    body.append(C.text(PAD, y, "dark frame · first light · deep field are the "
                               "telescope's own words: the calibration image "
                               "taken with the shutter closed, the first real "
                               "picture, and what appears when you stare at a "
                               "patch of sky that looked empty.",
                       13, C.GREY_MID))
    y += 34
    body.append(C.text(PAD, y, "Every criterion is reachable without a paid key: "
                               "a local model counts as light, and the bundled "
                               "scenarios count as fan-outs and fleets.",
                       13, C.GREY_MID))

    height = y + 56
    body.append(C.provenance(W, height - 22, "build_17_leveling.py"))
    C.write("17-leveling-ladder.svg", C.doc(W, height, "".join(body),
                                            "17-leveling-ladder"))


if __name__ == "__main__":
    build()

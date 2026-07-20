#!/usr/bin/env python3
"""11 — Code inventory treemap: area proportional to lines of source.

Counted 2026-07-16 on branch refactor-clean-code with:
  find <module>/src/... -name '*.java'|'*.ts'|'*.tsx'|'*.css' | xargs wc -l
Tests are drawn as dashed tiles inside their module. Deterministic layout
(squarified treemap, fixed input order).
"""

import svg_common as C

# (module, zone_color, [(tile, loc, is_test)])
DATA = [
    ("spectro-web", C.ZONE_FACE, [
        ("components/", 3553, False), ("lab/", 2490, False),
        ("prototype-en/", 1479, False), ("state/", 1112, False),
        ("graph/", 1025, False), ("App + root", 587, False),
        ("prototype/", 472, False), ("scenario/", 443, False),
        ("markdown/", 319, False), ("workspace/", 235, False),
        ("import/", 195, False), ("transport/", 146, False),
        ("i18n/", 136, False), ("effects/", 57, False),
        ("styles (css)", 4554, False), ("vitest suites", 2812, True),
    ]),
    ("spectro-core", C.ZONE_CORE, [
        ("provider/", 1529, False), ("mcp/", 1118, False),
        ("tools/", 904, False), ("subagents/", 858, False),
        ("dev.spectroscope.core (root)", 598, False), ("session/", 502, False),
        ("scheduler/", 502, False), ("config/", 475, False),
        ("image/", 468, False), ("skills/", 229, False),
        ("events/", 168, False), ("hooks/", 161, False),
        ("permission/", 121, False), ("JUnit suites", 6291, True),
    ]),
    ("spectro-cli", C.ZONE_FACE, [
        ("main", 3177, False), ("JUnit suites", 793, True),
    ]),
    ("spectro-server", C.ZONE_FACE, [
        ("main", 1346, False), ("JUnit suites", 764, True),
    ]),
    ("spectro-mcp-notes", C.ZONE_EXT, [
        ("main", 496, False), ("JUnit suites", 412, True),
    ]),
    ("spectro-desktop", C.ZONE_FACE, [("main.ts", 222, False)]),
    ("launcher + scripts", C.ZONE_DISK, [
        ("./spectro", 137, False), ("setup-stt/tts.sh", 185, False),
    ]),
]

W, H_MAP, PAD = 1680, 880, 56


def squarify(items, x, y, w, h):
    """Classic squarified treemap. items: [(key, value)] -> [(key, rect)]."""
    if not items:
        return []
    total = sum(v for _, v in items)
    if total <= 0 or w <= 0 or h <= 0:
        return []
    scale = (w * h) / total
    out, row, rest = [], [], list(items)

    def worst(row_vals, side):
        s = sum(row_vals)
        if s == 0 or side == 0:
            return float("inf")
        return max(max((side * side * v) / (s * s) for v in row_vals),
                   max((s * s) / (side * side * v) for v in row_vals))

    cx, cy, cw, ch = x, y, w, h
    while rest:
        item = rest[0]
        side = min(cw, ch)
        vals = [v * scale for _, v in row]
        cand = vals + [item[1] * scale]
        if not row or worst(cand, side) <= worst(vals, side):
            row.append(rest.pop(0))
            continue
        out.extend(_lay_row(row, scale, cx, cy, cw, ch))
        used = sum(v for _, v in row) * scale
        if cw >= ch:
            dx = used / ch
            cx, cw = cx + dx, cw - dx
        else:
            dy = used / cw
            cy, ch = cy + dy, ch - dy
        row = []
    if row:
        out.extend(_lay_row(row, scale, cx, cy, cw, ch))
    return out


def _lay_row(row, scale, x, y, w, h):
    out, s = [], sum(v for _, v in row) * scale
    if w >= h:
        rw = s / h if h else 0
        cy = y
        for key, v in row:
            rh = (v * scale) / rw if rw else 0
            out.append((key, (x, cy, rw, rh)))
            cy += rh
    else:
        rh = s / w if w else 0
        cx = x
        for key, v in row:
            rw = (v * scale) / rh if rh else 0
            out.append((key, (cx, cy_ := y, rw, rh)))
            cx += rw
    return out


def build():
    mk = C.Markers("treemap")
    body = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 11",
        "Code inventory.",
        "Area proportional to lines of source (main + tests), counted per module and package on 2026-07-16.")
    body.append(head)

    total = sum(v for _, _, tiles in DATA for _, v, _ in tiles)
    modules = [((name, color, tiles), sum(v for _, v, _ in tiles))
               for name, color, tiles in DATA]
    placed = squarify([(m, v) for m, v in modules],
                      PAD, y0, W - 2 * PAD, H_MAP)

    TEST_NOTES = {
        ("spectro-core", "JUnit suites"): "42 classes · 267 @Test",
        ("spectro-web", "vitest suites"): "22 files · 244 cases",
        ("spectro-cli", "JUnit suites"): "5 classes · 33 @Test",
        ("spectro-server", "JUnit suites"): "6 classes · 30 @Test",
        ("spectro-mcp-notes", "JUnit suites"): "4 classes · 18 @Test",
    }
    unlabeled = []
    GAPM = 7
    for (name, color, tiles), (mx, my, mw, mh) in placed:
        mx, my, mw, mh = mx + GAPM / 2, my + GAPM / 2, mw - GAPM, mh - GAPM
        mod_total = sum(v for _, v, _ in tiles)
        body.append(C.rect(mx, my, mw, mh, C.CARD_SOFT, C.STROKE, rx=10))
        loc_s = f"{mod_total:,} LOC"
        name_w = C.est_w(name, 15, weight=700)
        if name_w + C.est_w(loc_s, 12.5) + 34 <= mw:
            body.append(C.text(mx + 12, my + 22, name, 15, C.WHITE, 700))
            body.append(C.text(mx + 12 + name_w + 10, my + 22, loc_s, 12.5, C.GREY_MID))
        elif name_w + 24 <= mw:
            body.append(C.text(mx + 12, my + 22, name, 15, C.WHITE, 700))
        elif C.est_w(name, 11.5, weight=700) + 16 <= mw:
            body.append(C.text(mx + 10, my + 22, name, 11.5, C.WHITE, 700))
        else:
            parts = name.replace("-", "- ").split(" ", 1)
            body.append(C.text(mx + 10, my + 20, parts[0], 10.5, C.WHITE, 700))
            if len(parts) > 1:
                body.append(C.text(mx + 10, my + 34, parts[1], 10.5, C.WHITE, 700))
        inner = squarify([((t, v, is_t), v) for t, v, is_t in tiles],
                         mx + 8, my + 34, mw - 16, mh - 42)
        for (tname, v, is_t), (tx, ty, tw, th) in inner:
            g = 4
            tx, ty, tw, th = tx + g / 2, ty + g / 2, tw - g, th - g
            if tw <= 4 or th <= 4:
                continue
            dash = "5 4" if is_t else None
            fill = C.CARD if is_t else C.CARD_UP
            body.append(C.rect(tx, ty, tw, th, fill, color, rx=7, sw=1.1,
                               dash=dash))
            label, loc = tname, f"{v:,}"
            note = TEST_NOTES.get((name, tname))
            if tw > C.est_w(label, 13, True) + 14 and th > 44:
                body.append(C.text(tx + 8, ty + 19, label, 13,
                                   C.GREY_LIGHT, mono=True))
                body.append(C.text(tx + 8, ty + 36, loc + " LOC", 11.5,
                                   C.GREY_MID, mono=True))
                if note and th > 62 and tw > C.est_w(note, 11.5, True) + 16:
                    body.append(C.text(tx + 8, ty + 53, note, 11.5,
                                       C.GREY_DIM, mono=True))
            elif tw > C.est_w(label, 11, True) + 10 and th > 20:
                body.append(C.text(tx + 6, ty + 15, label, 11,
                                   C.GREY_MID, mono=True))
            else:
                unlabeled.append(f"{name} {label} ({v})")

    y_leg = y0 + H_MAP + 34
    body.append(C.legend(PAD, y_leg, [
        (C.ZONE_CORE, "core library", "stroke"),
        (C.ZONE_FACE, "faces (cli, server, web, desktop)", "stroke"),
        (C.ZONE_EXT, "example MCP server", "stroke"),
        (C.ZONE_DISK, "launcher + scripts", "stroke"),
        (C.GREY_MID, "dashed tile = test code", "dash"),
    ]))
    body.append(C.text(PAD, y_leg + 30,
                       f"Total: {total:,} lines across 6 modules + launcher. "
                       f"Gate on this state: 348 JUnit + 244 vitest, 0 failures.",
                       13.5, C.GREY_MID))
    if unlabeled:
        body.append(C.text(PAD, y_leg + 52,
                           "Too small to label: " + " · ".join(unlabeled),
                           11, C.GREY_DIM, mono=True))
    body.append(C.provenance(W, y_leg + 30, "build_11_treemap.py"))
    height = y_leg + 74
    return C.doc(W, height, f"<defs>{mk.defs()}</defs>" + "".join(body),
                 "treemap")


if __name__ == "__main__":
    C.write("11-code-inventory-treemap.svg", build())

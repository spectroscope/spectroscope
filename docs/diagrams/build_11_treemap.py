#!/usr/bin/env python3
"""11 — Code inventory treemap: area proportional to lines of source.

Counted from the tree AT BUILD TIME (no hardcoded table — the numbers can
never drift from the code again). The rule, same as the original 2026-07-16
hand count:

  newline count per file (wc -l), <module>/src/ only, main + tests.
  Extensions per module: .java for the Java modules, .ts/.tsx/.css for
  spectro-web and spectro-desktop, .c for the native PTY helper (an
  extension added when native/ appeared), .sh + the ./spectro launcher
  for the scripts group.

Stated exclusions: everything outside <module>/src/ (build/, gradle/,
docs/, samples/, node_modules/, module-root configs) never enters; the
generated vite bundle under spectro-server/src/main/resources/static/ is
excluded mechanically by the .java-only rule; non-source files inside
spectro-web/src (.jsonl fixtures, .md, .txt licenses, .woff2 fonts) fall
out via the extension rule. Tests are drawn as dashed tiles inside their
module (web tests = *.test.ts/tsx, Java tests = src/test). Deterministic
given a tree; the subtitle carries the build date.
"""

from datetime import date
from pathlib import Path

import svg_common as C

REPO = Path(__file__).resolve().parents[2]

JAVA_EXT = {".java"}
WEB_EXT = {".ts", ".tsx", ".css"}


def _loc(p: Path) -> int:
    return p.read_bytes().count(b"\n")


def _java_module(name: str):
    """(main_loc, [(test_loc, test_files, at_test_lines)])."""
    main = sum(_loc(p) for p in sorted((REPO / name / "src/main").rglob("*.java")))
    test = files = at = 0
    for p in sorted((REPO / name / "src/test").rglob("*.java")):
        test += _loc(p)
        files += 1
        at += sum(1 for ln in p.read_text(encoding="utf-8", errors="replace")
                  .splitlines() if "@Test" in ln)
    return main, test, files, at


def _core_tiles():
    """spectro-core main, rolled per package under dev.spectroscope.core."""
    base = REPO / "spectro-core/src/main/java/dev/spectroscope"
    rolled: dict[str, int] = {}
    for p in sorted(base.rglob("*.java")):
        rel = p.relative_to(base)
        if rel.parts[0] != "core":
            key = "dev.spectroscope (facade)"
        elif len(rel.parts) == 2:
            key = "dev.spectroscope.core (root)"
        else:
            key = rel.parts[1] + "/"
        rolled[key] = rolled.get(key, 0) + _loc(p)
    return [(k, v, False) for k, v in rolled.items() if v]


def _web_tiles():
    """spectro-web main per top-level src dir + one aggregated test tile."""
    src = REPO / "spectro-web/src"
    dirs: dict[str, int] = {}
    root = test = test_files = 0
    for p in sorted(src.rglob("*")):
        if not (p.is_file() and p.suffix in WEB_EXT):
            continue
        n = _loc(p)
        if p.name.endswith((".test.ts", ".test.tsx")):
            test += n
            test_files += 1
            continue
        rel = p.relative_to(src)
        if len(rel.parts) == 1:
            root += n
        else:
            dirs[rel.parts[0] + "/"] = dirs.get(rel.parts[0] + "/", 0) + n
    tiles = [(k, v, False) for k, v in dirs.items() if v]
    tiles.append(("App + root", root, False))
    tiles.append(("vitest suites", test, True))
    return tiles, test_files


def count_tree():
    """Build (DATA, TEST_NOTES) in the shape the layout has always eaten:
    [(module, zone_color, [(tile, loc, is_test)])], notes keyed (module, tile)."""
    notes: dict[tuple[str, str], str] = {}
    data = []

    web_tiles, web_test_files = _web_tiles()
    data.append(("spectro-web", C.ZONE_FACE, web_tiles))
    notes[("spectro-web", "vitest suites")] = f"{web_test_files} test files"

    core_main, core_test, core_files, core_at = _java_module("spectro-core")
    core_tiles = _core_tiles()
    assert sum(v for _, v, _ in core_tiles) == core_main
    data.append(("spectro-core", C.ZONE_CORE,
                 core_tiles + [("JUnit suites", core_test, True)]))
    notes[("spectro-core", "JUnit suites")] = f"{core_files} classes · {core_at} @Test"

    for name, zone in [("spectro-server", C.ZONE_FACE),
                       ("spectro-cli", C.ZONE_FACE),
                       ("spectro-orchestrator", C.ZONE_CORE),
                       ("spectro-mcp-notes", C.ZONE_EXT)]:
        main, test, files, at = _java_module(name)
        data.append((name, zone, [("main", main, False),
                                  ("JUnit suites", test, True)]))
        notes[(name, "JUnit suites")] = f"{files} classes · {at} @Test"

    desk = [(p.name, _loc(p), False)
            for p in sorted((REPO / "spectro-desktop/src").glob("*"))
            if p.is_file() and p.suffix in WEB_EXT]
    data.append(("spectro-desktop", C.ZONE_FACE, desk))

    nat = [(p.name, _loc(p), False)
           for p in sorted((REPO / "native").glob("*.c"))]
    data.append(("native", C.ZONE_DISK, nat))

    launcher = [("./spectro", _loc(REPO / "spectro"), False)]
    launcher += [(p.name, _loc(p), False)
                 for p in sorted((REPO / "scripts").glob("*.sh"))]
    data.append(("launcher + scripts", C.ZONE_DISK, launcher))

    # Descending order everywhere: squarify keeps its aspect ratios honest.
    data = [(name, zone, sorted(tiles, key=lambda t: -t[1]))
            for name, zone, tiles in data]
    data.sort(key=lambda m: -sum(v for _, v, _ in m[2]))
    return data, notes


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
    data, test_notes = count_tree()
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 11",
        "Code inventory.",
        "Area proportional to lines of source (main + tests), counted from "
        f"the tree at build time (this build: {date.today().isoformat()}).")
    body.append(head)

    total = sum(v for _, _, tiles in data for _, v, _ in tiles)
    modules = [((name, color, tiles), sum(v for _, v, _ in tiles))
               for name, color, tiles in data]
    placed = squarify([(m, v) for m, v in modules],
                      PAD, y0, W - 2 * PAD, H_MAP)

    unlabeled = []
    GAPM = 7
    for (name, color, tiles), (mx, my, mw, mh) in placed:
        mx, my, mw, mh = mx + GAPM / 2, my + GAPM / 2, mw - GAPM, mh - GAPM
        mod_total = sum(v for _, v, _ in tiles)
        body.append(C.rect(mx, my, mw, mh, C.CARD_SOFT, C.STROKE, rx=10))
        loc_s = f"{mod_total:,} LOC"
        # est_w runs ~15% narrow on long bold lowercase names (measured on
        # "spectro-orchestrator"); pad the estimate so the LOC never collides.
        name_w = C.est_w(name, 15, weight=700) * 1.15
        name_w13 = C.est_w(name, 13, weight=700) * 1.15
        if name_w + C.est_w(loc_s, 12.5) + 34 <= mw:
            body.append(C.text(mx + 12, my + 22, name, 15, C.WHITE, 700))
            body.append(C.text(mx + 12 + name_w + 10, my + 22, loc_s, 12.5, C.GREY_MID))
        elif name_w13 + C.est_w(loc_s, 11) + 28 <= mw:
            body.append(C.text(mx + 12, my + 22, name, 13, C.WHITE, 700))
            body.append(C.text(mx + 12 + name_w13 + 8, my + 22, loc_s, 11, C.GREY_MID))
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
            note = test_notes.get((name, tname))
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
                unlabeled.append(f"{name} {label} ({v:,})")

    y_leg = y0 + H_MAP + 34
    body.append(C.legend(PAD, y_leg, [
        (C.ZONE_CORE, "libraries (core, orchestrator)", "stroke"),
        (C.ZONE_FACE, "faces (cli, server, web, desktop)", "stroke"),
        (C.ZONE_EXT, "example MCP server", "stroke"),
        (C.ZONE_DISK, "launcher · scripts · native", "stroke"),
        (C.GREY_MID, "dashed tile = test code", "dash"),
    ]))
    n_modules = sum(1 for name, _, _ in data if name.startswith("spectro-"))
    body.append(C.text(PAD, y_leg + 30,
                       f"Total: {total:,} lines across {n_modules} modules "
                       f"+ launcher scripts + the native PTY helper, "
                       f"counted from this tree at build time.",
                       13.5, C.GREY_MID))
    body.append(C.text(PAD, y_leg + 50,
                       "Rule: newline count per file under <module>/src — "
                       ".java | .ts | .tsx | .css (native: .c, scripts: .sh); "
                       "generated bundles and non-source files fall out via "
                       "the extension rule.",
                       12, C.GREY_DIM))
    y_tail = y_leg + 50
    if unlabeled:
        for ln in C.wrap("Too small to label: " + " · ".join(unlabeled),
                         11, W - 2 * PAD, mono=True):
            y_tail += 20
            body.append(C.text(PAD, y_tail, ln, 11, C.GREY_DIM, mono=True))
    body.append(C.provenance(W, y_leg + 30, "build_11_treemap.py"))
    height = y_tail + 44
    return C.doc(W, height, f"<defs>{mk.defs()}</defs>" + "".join(body),
                 "treemap")


if __name__ == "__main__":
    C.write("11-code-inventory-treemap.svg", build())

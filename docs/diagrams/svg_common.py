#!/usr/bin/env python3
"""Shared drawing kit for the spectroscope architecture diagram suite.

Brand design language (design transplant, migration phase 4): vintage
espresso canvas (paper in the light theme), warm hairlines, Inter type,
violet as the one editorial highlight ("the line you follow"), amber
strictly for interaction / decision / live elements, spectral tones only
as zone decoration (never as running-text color). Color lives on the
lines; surfaces stay monochrome.

Theme switch: SPECTRO_DIAGRAM_THEME=dark|light (default dark) picks the
palette at import time — every build_*.py run is one process, so a build
loop exports both looks from the same geometry.

Every build_*.py in this folder imports this module. Deterministic:
same input, same output. No timestamps inside the drawing itself; the
provenance line carries a fixed source-verification date.
"""

import base64
import os
from html import escape
from pathlib import Path

# ---------------------------------------------------------------- palette
LIGHT_THEME = os.environ.get("SPECTRO_DIAGRAM_THEME", "dark").strip().lower() == "light"

if LIGHT_THEME:
    EBONY = "#F6F4EE"          # canvas: paper
    CARD = "#EFECE3"           # raised surface
    CARD_SOFT = "#F2EFE7"      # zone surface (between canvas and card)
    CARD_UP = "#E9E5D8"        # nested surface on top of CARD
    STROKE = "#DDD8CB"         # standard hairline on paper
    STROKE_SOFT = "#E6E1D4"    # quiet hairline / future
    WHITE = "#17161A"          # primary ink (the name stays for the suite)
    GREY_LIGHT = "#55514A"     # secondary text
    GREY_MID = "#6A665D"       # tertiary text
    GREY_DIM = "#A39E92"       # ghost text

    SAND = "#6C5CE7"           # editorial highlight: violet on paper
    SAND_DEEP = "#5646C9"
    CORAL = "#A9762A"          # interaction / decision / live: amber on paper

    # Spectral tones (decoration, zone coding; never as running-text color)
    MOSS, MOSS_DEEP = "#0F9D77", "#0B7A5D"
    OCEAN, OCEAN_DEEP = "#0B8799", "#086578"
    LILAC, LILAC_DEEP = "#6C5CE7", "#4A3CC0"
    SALMON, SALMON_DEEP = "#A9762A", "#7E5820"
    BLOSSOM, BLOSSOM_DEEP = "#C24B3E", "#93362B"
    CRIMSON, CRIMSON_DEEP = "#C24B3E", "#93362B"
else:
    EBONY = "#17120D"          # canvas: vintage espresso (never pure black)
    CARD = "#201913"           # raised surface
    CARD_SOFT = "#1C1610"      # zone surface (between canvas and card)
    CARD_UP = "#292019"        # nested surface on top of CARD
    STROKE = "#33291F"         # standard hairline on espresso
    STROKE_SOFT = "#2A2117"    # quiet hairline / future
    WHITE = "#EDE7DC"          # primary ink: warm cream (the name stays)
    GREY_LIGHT = "#C7BFB0"     # secondary text
    GREY_MID = "#A2988A"       # tertiary text
    GREY_DIM = "#5C5142"       # ghost text

    SAND = "#8B7CF0"           # editorial highlight: violet, the line you follow
    SAND_DEEP = "#6C5CE7"
    CORAL = "#CE9440"          # interaction / decision / live: the amber line

    # Spectral tones (decoration, zone coding; never as running-text color)
    MOSS, MOSS_DEEP = "#2DD4A7", "#1FA37F"
    OCEAN, OCEAN_DEEP = "#2CB1C4", "#1F8899"
    LILAC, LILAC_DEEP = "#8B7CF0", "#6C5CE7"
    SALMON, SALMON_DEEP = "#CE9440", "#A9762A"
    BLOSSOM, BLOSSOM_DEEP = "#C05A4C", "#8E3E33"
    CRIMSON, CRIMSON_DEEP = "#C05A4C", "#8E3E33"

# Semantic zone colors, IDENTICAL across the whole suite:
#   core (spectro-core) = teal      faces (cli/server/web/desktop) = ocean
#   providers/external  = amber     storage/disk                   = warm grey
#   event stream        = violet    decision/live                  = amber
ZONE_CORE, ZONE_CORE_DEEP = MOSS, MOSS_DEEP
ZONE_FACE, ZONE_FACE_DEEP = OCEAN, OCEAN_DEEP
ZONE_EXT, ZONE_EXT_DEEP = SALMON, SALMON_DEEP
ZONE_DISK, ZONE_DISK_DEEP = GREY_MID, GREY_DIM

# Uniquely-named embedded faces: a plain "Inter" would let a broken system
# font of the same name win when the SVG rides as an <img> data URI (no access
# to the HTML @font-face) — that was the print-to-pdf mojibake. These names
# resolve ONLY to the woff2 embedded in every doc() via _font_defs().
FONT = "'SpectroInter',-apple-system,'Helvetica Neue',Arial,sans-serif"
MONO = "'SpectroMono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

_FONTS_DIR = Path(__file__).resolve().parents[1].parent / "spectro-web/src/assets/fonts"
_FONT_FILES = {
    "SpectroInter": "inter-latin-wght-normal.woff2",
    "SpectroMono": "jetbrains-mono-latin-wght-normal.woff2",
}


def _font_defs() -> str:
    """A <style> with the brand faces base64-embedded, so every SVG renders the
    same font standalone, as an <img> data URI, and in headless-Chrome PDF."""
    faces = []
    for family, fname in _FONT_FILES.items():
        path = _FONTS_DIR / fname
        try:
            b64 = base64.b64encode(path.read_bytes()).decode()
        except OSError:
            continue  # fall back to the system stack if the woff2 is missing
        faces.append(
            f"@font-face{{font-family:'{family}';font-style:normal;"
            f"font-weight:100 900;font-display:block;"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2');}}"
        )
    return f"<style>{''.join(faces)}</style>" if faces else ""


VERIFIED = "source-verified 2026-07-20"

# ------------------------------------------------------------ text metrics
_NARROW = set("iljtf.,:;'|!ír()[]{} ")
_WIDE = set("mwMW@GOQ")


def est_w(s: str, size: float, mono: bool = False, weight: int = 400) -> float:
    """Approximate rendered width. Conservative (slightly wide)."""
    if mono:
        return len(s) * size * 0.62
    base = 0.545 if weight >= 700 else 0.52
    w = 0.0
    for ch in s:
        if ch in _NARROW:
            w += 0.30
        elif ch in _WIDE:
            w += 0.78
        elif ch.isupper() or ch.isdigit():
            w += 0.62
        else:
            w += base
    return w * size


def wrap(s: str, size: float, max_w: float, mono: bool = False) -> list[str]:
    words, lines, cur = s.split(), [], ""
    for word in words:
        cand = (cur + " " + word).strip()
        if cur and est_w(cand, size, mono) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


# ------------------------------------------------------------- primitives
def text(x, y, s, size=16, fill=WHITE, weight=400, anchor="start",
         mono=False, ls=None, opacity=None):
    fam = MONO if mono else FONT
    extra = ""
    if ls is not None:
        extra += f' letter-spacing="{ls}"'
    if opacity is not None:
        extra += f' opacity="{opacity}"'
    return (f'<text x="{x:.1f}" y="{y:.1f}" fill="{fill}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}" '
            f'font-family="{fam}"{extra}>{escape(str(s))}</text>')


def eyebrow(x, y, s, fill=SAND, size=14):
    return text(x, y, s.upper(), size, fill, 400, ls="0.18em", mono=True)


def rect(x, y, w, h, fill, stroke="none", rx=12, sw=1.0, dash=None,
         opacity=None):
    extra = ""
    if dash:
        extra += f' stroke-dasharray="{dash}"'
    if opacity is not None:
        extra += f' opacity="{opacity}"'
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="{rx}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{sw}"{extra}/>')


def line(x1, y1, x2, y2, stroke=STROKE, sw=1.0, dash=None):
    extra = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{stroke}" stroke-width="{sw}"{extra}/>')


def circle(cx, cy, r, fill, stroke="none", sw=1.0):
    return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}"/>')


class Markers:
    """Per-diagram-unique arrowhead ids (safe for inline HTML embedding)."""

    def __init__(self, slug: str):
        self.slug = slug
        self.colors: dict[str, str] = {}

    def id_for(self, color: str) -> str:
        key = color.strip("#").lower()
        self.colors[key] = color
        return f"ah-{self.slug}-{key}"

    def defs(self) -> str:
        out = []
        for key, color in sorted(self.colors.items()):
            out.append(
                f'<marker id="ah-{self.slug}-{key}" viewBox="0 0 10 10" '
                f'refX="8.5" refY="5" markerWidth="7" markerHeight="7" '
                f'orient="auto-start-reverse">'
                f'<path d="M0 0 L10 5 L0 10 z" fill="{color}"/></marker>')
        return "".join(out)


def arrow(mk: Markers, x1, y1, x2, y2, color=GREY_MID, sw=1.4, dash=None):
    extra = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{sw}"{extra} '
            f'marker-end="url(#{mk.id_for(color)})"/>')


def path_arrow(mk: Markers, d: str, color=GREY_MID, sw=1.4, dash=None):
    extra = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="{d}" fill="none" stroke="{color}" '
            f'stroke-width="{sw}"{extra} '
            f'marker-end="url(#{mk.id_for(color)})"/>')


# ------------------------------------------------------------- brand deco
# Brand deco removed in the de-brand pass (migration phase 2): the
# monogram and diamond helpers draw nothing so layouts keep working.
def m_mark(x, y, w, fill=SAND, opacity=1.0):
    return ""


def diamond(x, y, h, fill, opacity=1.0):
    return ""


# ---------------------------------------------------------- composite bits
def chip(x, y, label, color=GREY_LIGHT, size=13, pad=10, h=24, mono=True,
         fill=CARD_UP, stroke=STROKE, text_fill=None):
    """Small pill. Returns (svg, width). Pastel goes to STROKE, not type."""
    w = est_w(label, size, mono) + 2 * pad
    svg = rect(x, y, w, h, fill, stroke, rx=h / 2, sw=1)
    svg += text(x + pad, y + h / 2 + size * 0.36, label, size,
                text_fill or color, mono=mono)
    return svg, w


def chip_row(x, y, labels, max_w, color=GREY_LIGHT, size=13, gap=8, h=24,
             mono=True, fill=CARD_UP, stroke=STROKE, text_fill=None):
    """Wrapping row of chips. Returns (svg, next_y)."""
    out, cx, cy = [], x, y
    for lb in labels:
        w = est_w(lb, size, mono) + 20
        if cx > x and cx + w > x + max_w:
            cx, cy = x, cy + h + gap
        s, w = chip(cx, cy, lb, color, size, h=h, mono=mono, fill=fill,
                    stroke=stroke, text_fill=text_fill)
        out.append(s)
        cx += w + gap
    return "".join(out), cy + h


def card(x, y, w, h, title=None, accent=None, fill=CARD, stroke=STROKE,
         rx=12, title_size=16, dash=None, title_fill=WHITE):
    out = [rect(x, y, w, h, fill, stroke, rx=rx, sw=1.2, dash=dash)]
    if accent:
        out.append(f'<path d="M{x:.1f} {y + rx:.1f} v{h - 2 * rx:.1f}" '
                   f'stroke="{accent}" stroke-width="3"/>')
    if title:
        out.append(text(x + 16, y + 27, title, title_size, title_fill, 700))
    return "".join(out)


def header(width, eyebrow_s, title_s, subtitle_s=None, pad=56):
    """Standard suite header. Returns (svg, content_start_y)."""
    out = [eyebrow(pad, pad + 6, eyebrow_s)]
    out.append(text(pad, pad + 58, title_s, 44, WHITE, 640, ls="-0.01em"))
    y = pad + 58
    if subtitle_s:
        for ln in wrap(subtitle_s, 17, width - 2 * pad - 120):
            out.append(text(pad, y + 30, ln, 17, GREY_MID))
            y += 26
        y += 4
    out.append(m_mark(width - pad - 60, pad - 8, 60, SAND))
    out.append(line(pad, y + 26, width - pad, y + 26, STROKE_SOFT, 1))
    return "".join(out), y + 60


def legend(x, y, items, size=13):
    """items: list of (color, label, kind) with kind in fill|stroke|dash."""
    out, cx = [], x
    for color, label, kind in items:
        if kind == "fill":
            out.append(rect(cx, y - 11, 14, 14, color, "none", rx=4))
        elif kind == "stroke":
            out.append(rect(cx, y - 11, 14, 14, "none", color, rx=4, sw=1.6))
        else:
            out.append(line(cx, y - 4, cx + 14, y - 4, color, 1.6, dash="4 3"))
        cx += 20
        out.append(text(cx, y, label, size, GREY_MID))
        cx += est_w(label, size) + 26
    return "".join(out)


def label_pill(cx, cy, s, size=11, color=GREY_MID, mono=True, fill=EBONY):
    """Centered label on an ebony pill, safe to place across strokes."""
    w = est_w(s, size, mono) + 14
    h = size + 8
    out = rect(cx - w / 2, cy - h / 2 - 1, w, h, fill, "none", rx=h / 2)
    out += text(cx, cy + size * 0.34, s, size, color, anchor="middle", mono=mono)
    return out


def provenance(width, y, script, pad=56):
    s = f"generated: {script} · {VERIFIED}"
    return text(width - pad, y, s, 12, GREY_DIM, anchor="end")


def doc(width, height, body, slug):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}" width="{width}" '
            f'height="{height}" font-family="{FONT}">'
            f"{_font_defs()}"
            f'<rect width="{width}" height="{height}" fill="{EBONY}"/>'
            f"{body}</svg>")


def write(path: str, svg: str):
    # SPECTRO_DIAGRAM_OUTDIR redirects the whole suite (the light-theme
    # build exports next door without touching any build_*.py).
    outdir = os.environ.get("SPECTRO_DIAGRAM_OUTDIR")
    if outdir:
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, os.path.basename(path))
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"written: {path} ({len(svg)} bytes)")

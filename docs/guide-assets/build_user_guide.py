#!/usr/bin/env python3
"""build_user_guide.py — assembles spectro/docs/USER-GUIDE.html from parts.

Re-runnable generator (never hand-edit USER-GUIDE.html):
    cd spectro/docs/guide-assets && python3 build_user_guide.py

Inputs
  parts/NN-*.html        content fragments, concatenated in name order
  shots/*.png            real screenshots (capture_screens.mjs; the --light
                         build reads shots-light/ — same names, paper design)
  mermaid/*.svg          pre-rendered mermaid diagrams (render_mermaid.mjs)
  ../diagrams/*.svg      the 15 generated architecture SVGs

Placeholders inside parts
  <!--SHOT:name|caption-->      figure with the screenshot as data URI
  <!--SHOT:name|caption|half--> half-width variant
  <!--SVG:file-stem|caption-->  architecture diagram as data-URI img figure
  <!--MERMAID:name|caption-->   pre-rendered mermaid SVG inlined
  <!--TERM:file-stem|title-->   terminal block from <file-stem>.txt (ANSI stripped)
  <!--TOC-->                    generated chapter grid from all <h1 data-ch> and <h2>

The PDF is rendered from the finished HTML with headless Chrome:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --headless --disable-gpu --no-pdf-header-footer \
      --virtual-time-budget=20000 \
      --print-to-pdf=../USER-GUIDE.pdf ../USER-GUIDE.html
"""

import base64
import html as html_mod
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
PARTS = HERE / "parts"
MERMAID = HERE / "mermaid"
FONTS = HERE.parent.parent / "spectro-server/src/main/resources/static/assets"

# Both brand themes build from the same parts: `--light` picks the paper
# palette (guide.css [data-theme=light]), the light diagram suite AND the
# light screenshot set (the app in spectro bright).
THEME = "light" if "--light" in sys.argv else "dark"
DIAGRAMS = HERE.parent / ("diagrams/light" if THEME == "light" else "diagrams")
SHOTS = HERE / ("shots-light" if THEME == "light" else "shots")
OUT = HERE.parent / ("USER-GUIDE-LIGHT.html" if THEME == "light" else "USER-GUIDE.html")

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def shot_figure(m: re.Match) -> str:
    body = m.group(1)
    bits = body.split("|")
    name, caption = bits[0].strip(), bits[1].strip() if len(bits) > 1 else ""
    half = len(bits) > 2 and bits[2].strip() == "half"
    png = SHOTS / f"{name}.png"
    if not png.exists():
        sys.exit(f"missing screenshot: {png}")
    cls = "shot shot--half" if half else "shot"
    cap = f"<figcaption>{caption}</figcaption>" if caption else ""
    return (
        f'<figure class="{cls}"><img alt="{html_mod.escape(caption or name)}" '
        f'src="data:image/png;base64,{b64(png)}">{cap}</figure>'
    )


def svg_figure(m: re.Match) -> str:
    stem, _, caption = m.group(1).partition("|")
    svg = DIAGRAMS / f"{stem.strip()}.svg"
    if not svg.exists():
        sys.exit(f"missing diagram: {svg}")
    cap = f"<figcaption>{caption.strip()}</figcaption>" if caption.strip() else ""
    return (
        f'<figure class="diagram"><img alt="{html_mod.escape(stem)}" '
        f'src="data:image/svg+xml;base64,{b64(svg)}">{cap}</figure>'
    )


def mermaid_inline(m: re.Match) -> str:
    name, _, caption = m.group(1).partition("|")
    svg = MERMAID / f"{name.strip()}.svg"
    if not svg.exists():
        sys.exit(f"missing mermaid render: {svg} (run render_mermaid.mjs)")
    content = svg.read_text()
    content = re.sub(r"<\?xml[^?]*\?>", "", content)
    cap = f"<figcaption>{caption.strip()}</figcaption>" if caption.strip() else ""
    return f'<figure class="mermaid">{content}{cap}</figure>'


def term_block(m: re.Match) -> str:
    stem, _, title = m.group(1).partition("|")
    txt = HERE / f"{stem.strip()}.txt"
    if not txt.exists():
        sys.exit(f"missing terminal capture: {txt}")
    content = html_mod.escape(ANSI_RE.sub("", txt.read_text().rstrip()))
    head = title.strip() or "terminal"
    return (
        f'<div class="term"><div class="term-head"><span class="term-dot"></span>'
        f"{html_mod.escape(head)}</div><pre>{content}</pre></div>"
    )


def build_toc(full: str) -> str:
    """Chapter grid from <h1 data-ch> titles + their <h2> children. A part
    title (class="part-title") becomes a full-width section header (which also
    resets the two-column balance, so the columns stay even); the TOC's own
    heading skips itself; a chapter with no <h2> renders without the subs rail
    (an empty rail left a stray bordered box)."""
    items = []
    for m in re.finditer(r"<h1\b([^>]*)>(.*?)</h1>(.*?)(?=<h1\b|\Z)", full, re.S):
        attrs, inner, body = m.group(1), m.group(2), m.group(3)
        dm = re.search(r'data-ch="([^"]+)"', attrs)
        im = re.search(r'id="([^"]+)"', attrs)
        if not dm or not im:
            continue
        num, hid = dm.group(1), im.group(1)
        if hid == "toc":  # the map of this book is the TOC — never list itself
            continue
        # visible title = inner text minus a leading <span class="ch-num">…</span>
        title = re.sub(r"^\s*<span[^>]*>.*?</span>\s*", "", inner, flags=re.S).strip()
        if "part-title" in attrs:
            items.append(
                f'<div class="toc-part"><span class="toc-part-num">Part {num}</span>'
                f'<a href="#{hid}">{title}</a></div>'
            )
            continue
        subs = re.findall(r'<h2[^>]*id="([^"]+)"[^>]*>([^<]+)</h2>', body)
        sub_html = "".join(
            f'<a class="toc-sub" href="#{sid}">{stitle.strip()}</a>' for sid, stitle in subs
        )
        subs_div = f'<div class="toc-subs">{sub_html}</div>' if sub_html else ""
        items.append(
            f'<div class="toc-ch"><a class="toc-main" href="#{hid}">'
            f'<span class="toc-num">{num}</span> {title}</a>{subs_div}</div>'
        )
    return '<div class="toc">' + "".join(items) + "</div>"


def main() -> None:
    css = (HERE / "guide.css").read_text()
    # Brand fonts, self-hosted (phase 4): the server bundle already carries the
    # variable woff2 files — embed them so the guide renders identically
    # everywhere (both weights of the wordmark included).
    fonts = ""
    for family, pattern in (("Inter Variable", "inter-latin-wght-normal-*.woff2"),
                            ("JetBrains Mono Variable", "jetbrains-mono-latin-wght-normal-*.woff2")):
        matches = sorted(FONTS.glob(pattern))
        if matches:
            fonts += (
                f"@font-face {{ font-family: '{family}'; font-style: normal; "
                f"font-weight: 100 900; font-display: swap; "
                f"src: url(data:font/woff2;base64,{b64(matches[0])}) format('woff2-variations'); }}\n"
            )
    if fonts:
        css = css.replace("--font-ui: Inter,", "--font-ui: 'Inter Variable', Inter,")
        css = css.replace('--font-mono: "JetBrains Mono",', "--font-mono: 'JetBrains Mono Variable',")

    body = "\n".join(p.read_text() for p in sorted(PARTS.glob("*.html")))
    body = re.sub(r"<!--SHOT:([^>]+?)-->", shot_figure, body)
    body = re.sub(r"<!--SVG:([^>]+?)-->", svg_figure, body)
    body = re.sub(r"<!--MERMAID:([^>]+?)-->", mermaid_inline, body)
    body = re.sub(r"<!--TERM:([^>]+?)-->", term_block, body)
    body = body.replace("<!--TOC-->", build_toc(body))

    doc = f"""<!doctype html>
<html lang="en" data-theme="{THEME}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spectroscope — the complete user guide{" (light)" if THEME == "light" else ""}</title>
<style>
{fonts}
{css}
</style>
</head>
<body>
<table class="pagewrap">
<thead><tr><td class="page-spacer"></td></tr></thead>
<tfoot><tr><td class="page-spacer"></td></tr></tfoot>
<tbody><tr><td>
<div class="content">
{body}
</div>
</td></tr></tbody>
</table>
</body>
</html>
"""
    OUT.write_text(doc)
    print(f"wrote {OUT} ({len(doc) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()

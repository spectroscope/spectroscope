#!/usr/bin/env python3
"""16 — Platform split: the layout as it stands, and the recommended target.

The card 68 concept picture. The left half is the tree as verified: the
harness repo with the committed bundle and the canonical engine, the edu
app with its vendored copy, the Python edition with the second wire model.
The right half is the recommended target from konzept/PLATFORM-SPLIT.md
(product home): contracts plus B1, the engine as one pinned package, the
Python server slice against a written surface contract. The seams and the
invariants ride the labeled edges. Nothing here cuts a repo; that call
stays with the owner.

Source-verified against settings.gradle.kts, the module build files,
spectro-web/vite.config.ts, spectro-web/src/lab/ENGINE.md, the edu app's
package.json plus sync_engine.py, and the Python edition's test_wire.py
on 2026-07-28.
"""

import svg_common as C

W = 1680
PAD = 56
VERIFIED = "source-verified 2026-07-28"


def fit(s, size, max_w, mono=False, weight=400):
    """Measured, not eyeballed: refuse to emit text wider than its box."""
    w = C.est_w(s, size, mono, weight)
    if w > max_w:
        raise SystemExit(f"text overflows its box ({w:.0f}px > {max_w:.0f}px): {s!r}")
    return s


def pill(b, cx, cy, s, color, lo, hi, size=10):
    """A label pill whose measured width must stay inside [lo, hi]."""
    w = C.est_w(s, size, True) + 14
    if cx - w / 2 < lo or cx + w / 2 > hi:
        raise SystemExit(f"pill leaves its lane ({cx - w / 2:.0f}..{cx + w / 2:.0f} "
                         f"outside {lo:.0f}..{hi:.0f}): {s!r}")
    b.append(C.label_pill(cx, cy, s, size, color=color))


def row(b, x, y, w, tick, name, sub, h=44, dash=None):
    """An inner component row: colored tick, mono name, one quiet sub line."""
    b.append(C.rect(x, y, w, h, C.CARD, C.STROKE, rx=8, dash=dash))
    b.append(f'<path d="M{x:.1f} {y + 8:.1f} v{h - 16:.1f}" stroke="{tick}" stroke-width="3"/>')
    b.append(C.text(x + 16, y + 19, fit(name, 13, w - 32, True), 13, C.GREY_LIGHT, mono=True))
    b.append(C.text(x + 16, y + 35, fit(sub, 11, w - 32), 11, C.GREY_MID))
    return y + h


def build():
    mk = C.Markers("split")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 16",
        "Where the copies live.",
        "Card 68, concept only. The left half is the tree as it stands, every "
        "duplication named; the right half is the recommended target, contracts "
        "plus a pinned engine package. The seams ride the labeled edges. No repo "
        "is cut here; that decision stays with the owner.")
    b.append(head)

    top_y = y0 + 6
    lx, lw = PAD, 744            # left panel: today
    rx, rw = 880, 744            # right panel: target

    # ============================================================ left: today
    b.append(C.text(lx, top_y + 4, "TODAY · VERIFIED IN THE TREES", 12.5, C.GREY_MID, ls="0.14em"))
    hy = top_y + 18

    # -- the harness repo -------------------------------------------------
    # contents go into a sub-buffer so the card surface can be painted first
    hb = []
    hb.append(C.text(lx + 20, hy + 30, "spectroscope-harness/spectro", 17, C.WHITE, 700))
    hb.append(C.text(lx + lw - 16, hy + 28, "public repo · the release train", 11,
                     C.GREY_MID, anchor="end"))
    hb.append(C.text(lx + 20, hy + 50,
                     fit("five Gradle modules at 0.4.1; spectro-web and spectro-desktop "
                         "sit beside the Gradle build on purpose", 11.5, lw - 40),
                     11.5, C.GREY_MID))
    chips_svg, chips_end = C.chip_row(
        lx + 20, hy + 62,
        ["spectro-core · Central", "spectro-orchestrator · Central",
         "spectro-cli", "spectro-mcp-notes"],
        lw - 40, C.GREY_LIGHT, 11.5, h=22)
    hb.append(chips_svg)
    dep_y = chips_end + 16
    hb.append(C.text(lx + 20, dep_y,
                     fit("server depends on core, orchestrator and cli · orchestrator "
                         "exposes core as api · Central is append-only", 10.5, lw - 40),
                     10.5, C.GREY_DIM))
    ry = dep_y + 12
    r_srv = row(hb, lx + 20, ry, lw - 40, C.ZONE_FACE,
                "spectro-server · Spring Boot · :8080",
                "serves the web UI from resources/static: 12 built files tracked "
                "in git (bundle policy: card 65)")
    srv_mid = ry + 22
    ry = r_srv + 8
    r_web = row(hb, lx + 20, ry, lw - 40, C.ZONE_FACE,
                "spectro-web · Vite + React · package.json 0.1.0",
                "vite.config.ts:17 points outDir at the server's resources/static; "
                "the build has no dist of its own")
    web_mid = ry + 22
    ry = r_web + 8
    r_dsk = row(hb, lx + 20, ry, lw - 40, C.ZONE_FACE,
                "spectro-desktop · Electron",
                "bundles the server jar plus a JRE; unchanged while the jar "
                "embeds the web bundle")
    ry = r_dsk + 8
    r_eng = row(hb, lx + 20, ry, lw - 40, C.ZONE_CORE,
                "spectro-web/src/lab · the engine, canonical",
                "the ENGINE.md seam: a 19-file manifest plus tests, a list, not "
                "the directory; the shells stay harness-side")
    h1 = r_eng + 14 - hy
    b.append(C.card(lx, hy, lw, h1, None, fill=C.CARD_SOFT, stroke=C.ZONE_FACE_DEEP))
    b.extend(hb)

    # D2 as a labeled edge: the web build writes into the server's tree.
    loop_x = lx + lw + 26
    b.append(C.path_arrow(
        mk,
        f"M{lx + lw - 14:.1f} {web_mid:.1f} C {loop_x} {web_mid}, "
        f"{loop_x} {srv_mid}, {lx + lw - 8:.1f} {srv_mid:.1f}",
        C.ZONE_FACE, sw=1.6))
    pill(b, loop_x + 8, (web_mid + srv_mid) / 2, "outDir", C.ZONE_FACE,
         lx + lw, rx, size=10)

    # -- the two sibling repos, side by side ------------------------------
    sib_y = hy + h1 + 64
    sib_h = 118
    edu_x, edu_w = lx, 356
    py_x, py_w = lx + 388, 356

    b.append(C.card(edu_x, sib_y, edu_w, sib_h, None, accent=C.ZONE_CORE))
    b.append(C.text(edu_x + 16, sib_y + 26, "spectroscope-edu", 15, C.WHITE, 700))
    b.append(C.text(edu_x + edu_w - 14, sib_y + 25, "private", 10.5, C.GREY_MID, anchor="end"))
    row(b, edu_x + 14, sib_y + 38, edu_w - 28, C.ZONE_CORE,
        "src/lab · vendored copy",
        "byte-derived from canonical, prettier-normalized", dash="6 4")
    b.append(C.text(edu_x + 16, sib_y + sib_h - 16,
                    fit("consumes the engine as a physical copy", 10.5, edu_w - 32),
                    10.5, C.GREY_DIM))

    b.append(C.card(py_x, sib_y, py_w, sib_h, None, accent=C.SAND))
    b.append(C.text(py_x + 16, sib_y + 26, "spectroscope-harness-python", 15, C.WHITE, 700))
    b.append(C.text(py_x + py_w - 14, sib_y + 25, "no remote", 10.5, C.GREY_MID, anchor="end"))
    row(b, py_x + 14, sib_y + 38, py_w - 28, C.SAND,
        "events.py · the second wire model",
        "Java fixture verbatim: parse, re-serialize, byte-equal")
    b.append(C.text(py_x + 16, sib_y + sib_h - 16,
                    fit("package three directories deep · no server binds a port",
                        10.5, py_w - 32),
                    10.5, C.GREY_DIM))

    # The engine seam, with its invariant on the edge.
    eng_x = edu_x + 174
    b.append(C.arrow(mk, eng_x, hy + h1 + 4, eng_x, sib_y - 6, C.ZONE_CORE, sw=1.8))
    pill(b, eng_x, hy + h1 + 22, "sync_engine.py --check", C.ZONE_CORE, lx, lx + lw)
    pill(b, eng_x, hy + h1 + 44, "green · 19 files · runs in npm test", C.ZONE_CORE, lx, lx + lw)

    # The wire seam, with both cross-edition invariants on the edge.
    wire_x = py_x + 174
    b.append(C.arrow(mk, wire_x, hy + h1 + 4, wire_x, sib_y - 6, C.SAND, sw=1.8))
    pill(b, wire_x, hy + h1 + 22, "RunEvent JSONL · byte-compatible", C.SAND, lx, lx + lw)
    pill(b, wire_x, hy + h1 + 44, "five-lines facade · frozen in both", C.SAND, lx, lx + lw)

    # -- the websites strip (by-design duplication, out of scope) ---------
    web_y = sib_y + sib_h + 24
    web_h = 68
    b.append(C.rect(lx, web_y, lw, web_h, C.CARD_SOFT, C.STROKE_SOFT, rx=12))
    b.append(C.text(lx + 16, web_y + 27,
                    fit("websites: design/website in the umbrella is the source; sync "
                        "scripts mirror it to -website · -dev · -gallery", 12.5, lw - 32),
                    12.5, C.GREY_LIGHT))
    b.append(C.text(lx + 16, web_y + 48,
                    fit("Cloudflare git builds: push equals deploy · no split step "
                        "touches the mirrors except through the sync scripts", 11, lw - 32),
                    11, C.GREY_MID))
    left_end = web_y + web_h

    # ============================================================ right: target
    b.append(C.text(rx, top_y + 4, "TARGET · CONTRACTS PLUS B1 · RECOMMENDED", 12.5,
                    C.GREY_MID, ls="0.14em"))
    ty = top_y + 18

    # -- the engine as one package ----------------------------------------
    t1_h = 138
    b.append(C.card(rx, ty, rw, t1_h, None, fill=C.CARD_SOFT, stroke=C.ZONE_CORE_DEEP))
    b.append(C.text(rx + 20, ty + 30, "@spectroscope/engine", 17, C.WHITE, 700, mono=True))
    b.append(C.text(rx + rw - 16, ty + 28, "one package · B1: inside the harness repo",
                    11, C.GREY_MID, anchor="end"))
    t1_lines = [
        "the 19-file manifest and its tests gain a package identity; both "
        "consumers install a pinned version",
        "delivered as an npm pack tarball on the GitHub release (npm cannot "
        "install from a git subdirectory)",
        "the vendored copy and the drift gate retire together in the flip "
        "commit; the lockfile pin takes over",
    ]
    ly = ty + 52
    for ln in t1_lines:
        b.append(C.text(rx + 20, ly, fit(ln, 11.5, rw - 40), 11.5, C.GREY_MID))
        ly += 18
    b.append(C.text(rx + 20, ly + 4,
                    fit("B2, an engine repo with a real npm publish, is permanent: "
                        "owner gate", 11, rw - 40),
                    11, C.CORAL))

    # -- the two consumers, both on the pin -------------------------------
    con_y = ty + t1_h + 44
    con_h = 96
    b.append(C.card(rx, con_y, 356, con_h, None, accent=C.ZONE_FACE))
    b.append(C.text(rx + 16, con_y + 26, "spectro-web", 15, C.WHITE, 700))
    b.append(C.text(rx + 356 - 14, con_y + 25, "stays in the harness", 10.5,
                    C.GREY_MID, anchor="end"))
    b.append(C.text(rx + 16, con_y + 50, fit("installs the engine pin", 11.5, 324),
                    11.5, C.GREY_LIGHT))
    b.append(C.text(rx + 16, con_y + 72,
                    fit("bundle policy stays the card 65 owner call", 10.5, 324),
                    10.5, C.GREY_DIM))
    b.append(C.card(rx + 388, con_y, 356, con_h, None, accent=C.ZONE_CORE))
    b.append(C.text(rx + 404, con_y + 26, "spectroscope-edu", 15, C.WHITE, 700))
    b.append(C.text(rx + 744 - 14, con_y + 25, "private", 10.5, C.GREY_MID, anchor="end"))
    b.append(C.text(rx + 404, con_y + 50, fit("installs the engine pin", 11.5, 324),
                    11.5, C.GREY_LIGHT))
    b.append(C.text(rx + 404, con_y + 72,
                    fit("sync_engine.py stays one release as the escape hatch", 10.5, 324),
                    10.5, C.GREY_DIM))
    b.append(C.arrow(mk, rx + 178, ty + t1_h + 6, rx + 178, con_y - 6, C.ZONE_CORE, sw=1.8))
    pill(b, rx + 178, ty + t1_h + 22, "pinned version", C.ZONE_CORE, rx, rx + rw)
    b.append(C.arrow(mk, rx + 566, ty + t1_h + 6, rx + 566, con_y - 6, C.ZONE_CORE, sw=1.8))
    pill(b, rx + 566, ty + t1_h + 22, "explicit bump, not a silent sync", C.ZONE_CORE,
         rx, rx + rw)

    # -- the server-surface contract --------------------------------------
    t2_y = con_y + con_h + 30
    t2_h = 100
    b.append(C.card(rx, t2_y, rw, t2_h, None, accent=C.SAND))
    b.append(C.text(rx + 16, t2_y + 27, "SERVER-SURFACE.md · the contract to write",
                    15, C.WHITE, 700))
    b.append(C.text(rx + 16, t2_y + 50,
                    fit("the minimum HTTP surface the app actually needs: sessions, "
                        "replay, config, and what /ws carries", 11.5, rw - 32),
                    11.5, C.GREY_MID))
    b.append(C.text(rx + 16, t2_y + 68,
                    fit("read from the real controllers; step 1 of the order, useful "
                        "under every layout", 11.5, rw - 32),
                    11.5, C.GREY_MID))
    b.append(C.text(rx + 16, t2_y + 88,
                    fit("the Python-server seam: the wire stays the deeper contract",
                        11, rw - 32),
                    11, C.GREY_DIM))

    # -- the two servers under one contract -------------------------------
    srv2_y = t2_y + t2_h + 44
    srv2_h = 96
    b.append(C.card(rx, srv2_y, 356, srv2_h, None, accent=C.ZONE_FACE))
    b.append(C.text(rx + 16, srv2_y + 26, "spectro-server · Java", 15, C.WHITE, 700))
    b.append(C.text(rx + 16, srv2_y + 50, fit("implements the surface today", 11.5, 324),
                    11.5, C.GREY_LIGHT))
    b.append(C.text(rx + 16, srv2_y + 72,
                    fit("keeps serving the UI from the jar", 10.5, 324),
                    10.5, C.GREY_DIM))
    b.append(C.card(rx + 388, srv2_y, 356, srv2_h, None, accent=C.ZONE_FACE, dash="6 4"))
    b.append(C.text(rx + 404, srv2_y + 26, "Python server slice · step 4", 15, C.WHITE, 700))
    b.append(C.text(rx + 404, srv2_y + 50,
                    fit("read-only first: sessions, JSONL replay, config stub", 11, 324),
                    11, C.GREY_LIGHT))
    b.append(C.text(rx + 404, srv2_y + 72,
                    fit("vendors one released bundle, no build-time fetch", 10.5, 324),
                    10.5, C.GREY_DIM))
    b.append(C.arrow(mk, rx + 178, t2_y + t2_h + 6, rx + 178, srv2_y - 6, C.SAND, sw=1.8))
    pill(b, rx + 178, t2_y + t2_h + 22, "answers to it today", C.SAND, rx, rx + rw)
    b.append(C.arrow(mk, rx + 566, t2_y + t2_h + 6, rx + 566, srv2_y - 6, C.SAND,
                     sw=1.8, dash="5 4"))
    pill(b, rx + 566, t2_y + t2_h + 22, "built against it", C.SAND, rx, rx + rw)

    b.append(C.text(rx + rw / 2, srv2_y + srv2_h + 26,
                    fit("layout C, the web app as its own repo, waits for this second "
                        "bundle consumer to exist", 11, rw),
                    11, C.GREY_DIM, anchor="middle"))
    right_end = srv2_y + srv2_h + 34

    # ============================================================ steps band
    sb_y = max(left_end, right_end) + 34
    # measure the chip rows first so the band is exactly tall enough
    steps = ["0 repair the drift gate · done 2026-07-28", "1 write SERVER-SURFACE.md",
             "2 flatten the Python repo", "3 B1: the engine pin",
             "4 Python read-only slice", "5 B2: engine repo · owner gate",
             "6 C: web split · owner gate"]
    _, probe_end = C.chip_row(PAD + 16, 0, steps, W - 2 * PAD - 32, C.GREY_LIGHT, 11.5, h=24)
    sb_h = 46 + probe_end + 16
    b.append(C.card(PAD, sb_y, W - 2 * PAD, sb_h,
                    "The order: every step reversible, two owner gates", accent=C.CORAL))
    chips2, _ = C.chip_row(PAD + 16, sb_y + 46, steps, W - 2 * PAD - 32,
                           C.GREY_LIGHT, 11.5, h=24)
    b.append(chips2)

    # ---- one-line truth --------------------------------------------------
    b.append(C.text(W / 2, sb_y + sb_h + 30,
                    fit("Nothing here cuts a repo. The facade stays frozen, the wire "
                        "stays byte-compatible, the drift gate stays green until only "
                        "one engine exists, and push stays deploy.", 12.5, W - 2 * PAD),
                    12.5, C.GREY_MID, anchor="middle"))

    # ============================================================ legend
    ly2 = sb_y + sb_h + 74
    b.append(C.line(PAD, ly2 - 26, W - PAD, ly2 - 26, C.STROKE_SOFT))
    b.append(C.legend(PAD, ly2, [
        (C.ZONE_CORE, "the engine (canonical or pinned)", "stroke"),
        (C.ZONE_FACE, "faces: server · web · desktop", "stroke"),
        (C.SAND, "seams and invariants on the edges", "fill"),
        (C.CORAL, "owner gate / open call", "fill"),
        (C.GREY_MID, "dashed = copy or not built yet", "dash"),
    ]))
    b.append(C.text(W - PAD, ly2,
                    f"generated: build_16_platform_split.py · {VERIFIED}",
                    12, C.GREY_DIM, anchor="end"))
    return C.doc(W, ly2 + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "16-platform-split")


if __name__ == "__main__":
    C.write("16-platform-split.svg", build())

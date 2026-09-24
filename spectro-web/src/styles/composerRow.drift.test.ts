// Card 383: the row of icons under the message field gets its space back.
//
// THE COMPLAINT AND THE MEASUREMENT. The owner read the row as big icons
// standing far apart and asked for Claude's row as the size to follow. The
// icons are 16 CSS px and the gap was 8 px. What was big is the box around each
// glyph: `.attach-button` declared a 44 px square, so 14 px of blank ring sat on
// every side of a 16 px picture and two neighbouring glyph centres stood 52 px
// apart.
//
// THE SIZE COMES FROM HIS REFERENCE (fix round 2026-09-24). The first build
// took 32 px from this tree's own `.icon-button` and set his reference aside.
// His screenshot of Claude's composer was then measured: Claude's glyphs are
// the same 16 px class as ours, and its icons stand 22 px centre to centre.
// So the glyph stays at 16 px, the box comes down to the ladder rung at or
// above that pitch, and the boxes stand edge to edge. The reading is in the
// CLAUDE constant below, with its source.
//
// WHAT THIS FILE ASSERTS IT COMPUTES, rather than typing. The `--sp-*` values
// come out of tokens.css, the box sizes out of the stylesheets in the cascade
// order app.css declares, the control list out of Chat.tsx and the four
// components it mounts, and the glyph sizes out of the svg attributes. The
// exceptions are typed on purpose: the row's child count, which is an owner
// decision (audit 2026-09-21, section H), and Claude's three distances, which
// are a reading of another product.
//
// THE REACH IS A DELIBERATE DEVIATION, recorded here so it is not silent.
// UI-UX-CONCEPT section 6 (docs/design/UI-UX-CONCEPT.md in the harness
// checkout, the path base.css:2 names) asks for touch targets of at least
// 44 px "despite the desktop focus". At Claude's pitch the widest reach that
// cannot take a neighbour's click is the pitch itself, and upward the reach can
// only grow to the field's edge. An overlapping reach hands the click to the
// wrong control, which is worse than the shortfall, so the shortfall is stated
// rather than hidden. The concept document lives in a different repository and
// is the owner's to edit; the card lists it as an open owner call.

import { describe, expect, it } from "vitest";
import { blockOf, read, rules, stripComments } from "../testkit/source";

const app = read("../app.css", import.meta.url);
const tokens = read("../tokens.css", import.meta.url);
const chat = read("../components/Chat.tsx", import.meta.url);

/** The four files that declare a button this row mounts but does not contain. */
const MOUNTED = ["PlusMenuSettings", "DisclosureMenu", "MicMenu", "ComposerGear"] as const;

// ---- resolving a declared value to CSS px -----------------------------------

/** The spacing ladder, read out of tokens.css rather than remembered. */
const SPACING = new Map<string, number>(
  [...tokens.matchAll(/--(sp-\d+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]),
);

/** The raw value a rule declares for `prop`, or null when it declares none. */
function declared(decls: string, prop: string): string | null {
  // The `(?:^|;)` anchor is the whole point: asked for `width`, a bare
  // substring search answers with `min-width`, and this file asks for exactly
  // that property on a rule that carries both.
  const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/**
 * A `12px`, a `var(--sp-3)` or a `calc(<a> - <b>)` of those as a number, or a
 * throw naming what failed. The calc form carries the one negative margin in
 * the row, which says in the stylesheet which two rungs it moves between.
 */
function px(value: string | null, what: string): number {
  if (value === null) throw new Error(`${what}: nothing is declared`);
  const calc = value.match(/^calc\((.+?)\s+([-+])\s+(.+)\)$/);
  if (calc) {
    const a = px(calc[1].trim(), `${what} (left of ${calc[2]})`);
    const b = px(calc[3].trim(), `${what} (right of ${calc[2]})`);
    return calc[2] === "-" ? a - b : a + b;
  }
  const token = value.match(/^var\(--(sp-\d+)\)$/);
  if (token) {
    const n = SPACING.get(token[1]);
    if (n === undefined) throw new Error(`${what}: tokens.css has no --${token[1]}`);
    return n;
  }
  if (value === "0") return 0;
  const literal = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (literal) return Number(literal[1]);
  throw new Error(`${what}: cannot resolve "${value}" to px`);
}

/** The bottom of a `padding` shorthand, or of an explicit `padding-bottom`. */
function paddingBottom(decls: string, what: string): number {
  const own = declared(decls, "padding-bottom");
  if (own !== null) return px(own, `${what} padding-bottom`);
  const short = declared(decls, "padding");
  if (short === null) throw new Error(`${what}: declares no padding at all`);
  const parts = short.split(/\s+(?![^(]*\))/);
  const bottom = { 1: parts[0], 2: parts[0], 3: parts[2], 4: parts[2] }[parts.length];
  if (bottom === undefined) throw new Error(`${what}: padding has ${parts.length} parts`);
  return px(bottom, `${what} padding bottom`);
}

// ---- the stylesheets, in the order app.css imports them ---------------------

/**
 * Every rule in the tree, in cascade order.
 *
 * <p>Order matters here and reading it out of app.css is not decoration:
 * `.attach-button` used to beat `.icon-button` at equal specificity only
 * because attachments-voice.css is imported after base.css. A guard that
 * resolved a box size by taking the first match would have reported the base
 * primitive's 32 px while the shipped row stood at 44.</p>
 */
const SHEETS = [...app.matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);

const ALL_RULES = SHEETS.flatMap((name) =>
  rules(name, read(`./${name}`, import.meta.url)),
);

/** The value the cascade actually lands on for one class and one property. */
function resolved(cls: string, prop: string): string | null {
  let value: string | null = null;
  for (const rule of ALL_RULES) {
    if (rule.selector !== cls) continue;
    const here = declared(rule.body, prop);
    if (here !== null) value = here;
  }
  return value;
}

// ---- the row, read out of Chat.tsx ------------------------------------------

/** The `<div className="composer-actions">` element, opening tag to closer. */
function rowMarkup(): string {
  const open = '<div className="composer-actions">';
  const start = chat.indexOf(open);
  if (start < 0) throw new Error("Chat.tsx no longer opens a .composer-actions div");
  let depth = 0;
  let i = start;
  for (;;) {
    const m = /<(\/?)div\b([^>]*)>/.exec(chat.slice(i));
    if (!m) throw new Error("the .composer-actions div is not closed");
    const selfClosing = m[2].trimEnd().endsWith("/");
    if (m[1] === "/") depth -= 1;
    else if (!selfClosing) depth += 1;
    i += m.index + m[0].length;
    if (depth === 0) return chat.slice(start, i);
  }
}

/**
 * The row's direct children, counted off the source's own indentation.
 *
 * <p>Derived rather than typed, which is the point: a seventh control added to
 * the row turns the count red without anyone editing this file. It leans on
 * the tree being prettier-formatted, which `npm run gate` enforces with
 * `prettier --check`, so a reformat cannot quietly change the answer.</p>
 *
 * <p>A JSX comment at that indentation is not a child and a closing tag is not
 * a child; both are excluded by what they start with.</p>
 */
function rowChildLines(): string[] {
  const lines = chat.split("\n");
  const head = lines.findIndex((l) => l.includes('<div className="composer-actions">'));
  if (head < 0) throw new Error("Chat.tsx no longer opens a .composer-actions div");
  const indent = lines[head].length - lines[head].trimStart().length;
  const markup = rowMarkup();
  const last = head + markup.split("\n").length - 1;
  const out: string[] = [];
  for (let n = head + 1; n < last; n++) {
    const line = lines[n];
    if (line.length - line.trimStart().length !== indent + 2) continue;
    const text = line.trim();
    if (text.startsWith("{/*")) continue;
    if (text.startsWith("</")) continue;
    if (text.startsWith("<") || text.startsWith("{")) out.push(text);
  }
  return out;
}

/** One control in the row: the classes it carries and where they were read. */
interface Control {
  readonly where: string;
  readonly classes: readonly string[];
}

/**
 * Every control the row puts on screen, with its class list read from source.
 *
 * <p>Three of the five sit in components rather than in the row's own markup
 * (PlusMenuSettings, DisclosureMenu, ComposerGear), and the device chevron in
 * a fourth, so naming them here would have been naming a list that the next
 * change to the row leaves behind.</p>
 */
function controls(): Control[] {
  const sources: [string, string][] = [
    ["Chat.tsx row", rowMarkup()],
    ...MOUNTED.map(
      (n) => [`${n}.tsx`, read(`../components/${n}.tsx`, import.meta.url)] as [string, string],
    ),
  ];
  const out: Control[] = [];
  for (const [where, src] of sources) {
    for (const m of stripComments(src).matchAll(/"([^"]*\bicon-button\b[^"]*)"/g)) {
      out.push({ where, classes: m[1].split(/\s+/).filter(Boolean) });
    }
  }
  return out;
}

/** The box a control resolves to, in px, both axes. */
function boxOf(c: Control): { width: number; height: number } {
  let width: number | null = null;
  let height: number | null = null;
  for (const cls of c.classes) {
    const w = resolved(`.${cls}`, "width");
    const h = resolved(`.${cls}`, "height");
    if (w !== null) width = px(w, `.${cls} width`);
    if (h !== null) height = px(h, `.${cls} height`);
  }
  if (width === null || height === null) {
    throw new Error(`${c.where} [${c.classes.join(" ")}]: no box resolves`);
  }
  return { width, height };
}

/**
 * The area a control's padded `::before` covers, in px, both axes, plus how
 * far it grows above and below its box on their own. The inset shorthand is
 * read with one to four values in the order CSS gives them (top, right,
 * bottom, left), because the row's reach grows up and down and not sideways.
 * `up` and `down` are separate because the total height cannot tell 4 up and
 * 4 down from 8 up and 0 down, and only the first stops at the field.
 */
function reachOf(
  c: Control,
): { width: number; height: number; up: number; down: number; via: string } | null {
  for (const cls of c.classes) {
    const inset = resolved(`.${cls}::before`, "inset");
    if (inset === null) continue;
    const parts = inset.split(/\s+(?![^(]*\))/).map((v) => px(v, `.${cls}::before inset`));
    const [top, right = top, bottom = top, left = right] = parts;
    const box = boxOf(c);
    return {
      width: box.width - left - right,
      height: box.height - top - bottom,
      up: -top,
      down: -bottom,
      via: `.${cls}::before`,
    };
  }
  return null;
}

// ---- the numbers every case below is measured against -----------------------

const GAP = px(declared(blockOf(read("./modal-composer.css", import.meta.url), ".composer-actions"), "gap"), ".composer-actions gap");
const CONTROLS = controls();

/** The row's square controls: all of them but the narrow device chevron. */
const SQUARES = CONTROLS.filter((c) => boxOf(c).width === boxOf(c).height);

/** The side of a square control, as the cascade resolves it. */
const BOX = SQUARES.length > 0 ? boxOf(SQUARES[0]).width : Number.NaN;

/** The distance between two neighbouring square controls' centres. */
const CENTRES = BOX + GAP;

/**
 * The rule that sets the space between the field and the icon row, and only
 * there. Found by its parsed selector: the subject is `.composer-actions` and
 * the whole selector is `.composer-box + .composer-actions`, an adjacent
 * sibling of the field. A grep for the compound class would also match every
 * rule that styles `.composer-actions` under some ancestor.
 */
const FIELD_TO_ROW_SELECTOR = ".composer-box + .composer-actions";

function normalised(selector: string): string {
  return selector.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

/** Every rule about `.composer-actions` that moves it by a margin. */
function rowMarginRules() {
  return ALL_RULES.filter(
    (r) =>
      r.subject === ".composer-actions" &&
      (declared(r.body, "margin") !== null || declared(r.body, "margin-top") !== null),
  );
}

/** The space between the bottom of the field and the top of the icon row. */
function fieldToRow(): number {
  const inner = px(
    declared(blockOf(read("./modal-composer.css", import.meta.url), ".composer-inner"), "gap"),
    ".composer-inner gap",
  );
  const own = rowMarginRules().filter((r) => normalised(r.selector) === FIELD_TO_ROW_SELECTOR);
  if (own.length === 0) return inner;
  if (own.length > 1) throw new Error(`${FIELD_TO_ROW_SELECTOR} is declared ${own.length} times`);
  return inner + px(declared(own[0].body, "margin-top"), `${FIELD_TO_ROW_SELECTOR} margin-top`);
}

/**
 * The Claude composer the owner sent as his size reference, measured.
 *
 * <p>Source: his message of 2026-09-21 15:56:01 UTC in session 502529f2 carried
 * two screenshots, ours and Claude's, with the words "Orientier dich lieber ein
 * bisschen mehr an der Claude UI von der Groesse her". Both are decoded under
 * kanban/evidence/383/fix-2026-09-24/ in the home repository, with the script
 * that measured them (measure_row.py) and its output. Claude's image is a
 * 1964 px wide PNG at device pixel ratio 2, so one CSS px is two image px. The
 * ratio is checked against the text in the same image: the "Auto" label's cap
 * height is 19 image px, 9.5 CSS px, which is a 13 to 14 px UI label.</p>
 *
 * <p>These three numbers cannot be derived from this tree. They are a reading
 * of another product, so they are typed, with the reading beside them.</p>
 */
const CLAUDE = {
  /** plus to microphone, centre to centre: 44 image px. */
  pitch: 22.0,
  /** bottom border of the field to the row's centre line: 35.5 image px. */
  fieldToRowCentre: 17.75,
  /** the row's centre line to the bottom edge of the composer: 40.5 image px. */
  rowCentreToEnd: 20.25,
} as const;

describe("the row under the composer is a toolbar, not a second input (card 383)", () => {
  const attachments = read("./attachments-voice.css", import.meta.url);
  const modal = read("./modal-composer.css", import.meta.url);

  it("gives the square buttons one square box with a whole pixel ring around the glyph", () => {
    // Criterion 1 as corrected in the fix round of 2026-09-24. The first build
    // deleted the box and fell back to .icon-button's 32 px; the owner's
    // reference asks for the size of Claude's row, so the box is declared
    // again, square, and small enough for the pitch below. The ring has to be
    // a whole number of px, so the glyph sits a whole number of px inside its
    // box. Where the box itself lands is not pinned, so this is not a claim
    // about device pixels (see the caveat in the glyph case below).
    const block = blockOf(attachments, ".attach-button");
    const w = px(declared(block, "width"), ".attach-button width");
    const h = px(declared(block, "height"), ".attach-button height");
    expect(w, ".attach-button is not square").toBe(h);
    const widest = Math.max(...glyphStates().map((g) => g.px));
    expect(((w - widest) / 2) % 1, `ring around a ${widest}px glyph in a ${w}px box`).toBe(0);
    // One row height: the chevron is narrow, but not shorter or taller.
    for (const c of CONTROLS) {
      expect(boxOf(c).height, `${c.where} [${c.classes.join(" ")}] height`).toBe(h);
    }
  });

  it("sits within one --sp-1 rung of the Claude composer the owner sent, on all three distances", () => {
    // Criterion 9, added in the fix round of 2026-09-24: his words named
    // Claude's row as the size to follow. Each distance of ours is computed
    // from the stylesheets and compared with the reading in CLAUDE above. The
    // tolerance is one rung of the house ladder, because ours can only stand on
    // the ladder and Claude's does not.
    const rung = SPACING.get("sp-1");
    if (rung === undefined) throw new Error("tokens.css has no --sp-1");
    const tallest = Math.max(...CONTROLS.map((c) => boxOf(c).height));
    const below = paddingBottom(blockOf(modal, ".composer"), ".composer");
    const ours = {
      pitch: CENTRES,
      fieldToRowCentre: fieldToRow() + tallest / 2,
      rowCentreToEnd: tallest / 2 + below,
    };
    for (const key of ["pitch", "fieldToRowCentre", "rowCentreToEnd"] as const) {
      expect(
        Math.abs(ours[key] - CLAUDE[key]),
        `${key}: ours ${ours[key]}px, Claude ${CLAUDE[key]}px`,
      ).toBeLessThanOrEqual(rung);
    }
  });

  it("keeps the base icon control at the size the send seat also uses", () => {
    // The other half of criterion 1: the row comes down through its own
    // .attach-button rule and not by shrinking the shared primitive.
    // .icon-button is used across the app (header, panels, settings), so it
    // stays at 32 px, and so does the send seat beside the row.
    expect(px(resolved(".icon-button", "width"), ".icon-button width")).toBe(32);
    expect(px(resolved(".icon-button", "height"), ".icon-button height")).toBe(32);
    expect(px(resolved(".composer-seat", "width"), ".composer-seat width")).toBe(32);
  });

  it("spends at most 48px on the whole block under the field", () => {
    // Criterion 2, and the one that answers the complaint: it measures the
    // space, not one icon. Gap above the row, the tallest control in it, and
    // the composer's own bottom padding. It was 8 + 44 + 16 = 68.
    const above = fieldToRow();
    const tallest = Math.max(...CONTROLS.map((c) => boxOf(c).height));
    const below = paddingBottom(blockOf(modal, ".composer"), ".composer");
    expect(above + tallest + below, `${above} + ${tallest} + ${below}`).toBeLessThanOrEqual(48);
  });

  it("leaves at most 24px between two glyph edges", () => {
    // Criterion 3: ring plus gap plus ring, all three read out of the tree.
    // It was 14 + 8 + 14 = 36.
    const glyphs = glyphStates();
    const ring = Math.max(
      ...CONTROLS.map((c) => {
        const box = boxOf(c);
        const widest = Math.max(...glyphs.map((g) => g.px));
        return (box.width - widest) / 2;
      }),
    );
    expect(ring * 2 + GAP, `${ring} + ${GAP} + ${ring}`).toBeLessThanOrEqual(24);
  });

  it("gives every square control the whole pitch as its width and reaches up to the field, not into it", () => {
    // Criterion 4 as corrected in the fix round of 2026-09-24. At Claude's
    // pitch the boxes stand edge to edge, so the widest reach that cannot take
    // a neighbour's click is the pitch itself. Upward the reach can grow by
    // exactly the space to the field and no further, or a click on the field's
    // bottom edge would open a menu. Downward it grows by the same amount into
    // the composer's own padding, and not past it. Up and down are asserted
    // one by one: the total height alone passes 8 up and 0 down, which reaches
    // into the field. The shortfall against UI-UX-CONCEPT section 6 is the
    // deviation named in this file's header and in the card's owner calls.
    expect(SQUARES.length, "no square control was found at all").toBeGreaterThan(0);
    const below = paddingBottom(blockOf(modal, ".composer"), ".composer");
    for (const c of SQUARES) {
      const reach = reachOf(c);
      expect(reach, `${c.where} [${c.classes.join(" ")}] has no padded ::before`).not.toBe(null);
      if (reach === null) continue;
      expect(reach.width, `${reach.via} reaches ${reach.width}px wide`).toBe(CENTRES);
      expect(reach.up, `${reach.via} reaches ${reach.up}px up, the field is ${fieldToRow()}px up`).toBe(
        fieldToRow(),
      );
      expect(reach.down, `${reach.via} reaches ${reach.down}px down`).toBe(fieldToRow());
      expect(reach.down, `${reach.via} reaches past the composer's ${below}px padding`).toBeLessThanOrEqual(below);
      expect(reach.height, `${reach.via} reaches ${reach.height}px tall`).toBe(
        boxOf(c).height + 2 * fieldToRow(),
      );
    }
  });

  it("gives the narrow device chevron a tall reach and a narrow one, so it cannot steal its neighbours' clicks", () => {
    // Criterion 4's separate case, and the test name says which way it is
    // separate. The chevron's box is narrower than the square controls',
    // so its centre stands closer to its neighbours' than theirs stand to each
    // other. With the boxes edge to edge, what fits sideways is the chevron's
    // own box: twice the distance left over once the neighbour has taken its
    // half of the pitch. Any wider and it runs into the microphone's reach. Up and down are asserted one by one, as for the
    // square controls, so the reach stops at the field's edge.
    const chevron = CONTROLS.filter((c) => boxOf(c).width !== boxOf(c).height);
    expect(chevron.length, "the row no longer has a non-square control").toBe(1);
    const box = boxOf(chevron[0]);
    const toNeighbour = box.width / 2 + GAP + BOX / 2;
    const widest = 2 * (toNeighbour - CENTRES / 2);
    const reach = reachOf(chevron[0]);
    expect(reach, "the chevron has no padded ::before").not.toBe(null);
    if (reach === null) return;
    expect(reach.up, `${reach.via} reaches ${reach.up}px up, the field is ${fieldToRow()}px up`).toBe(fieldToRow());
    expect(reach.down, `${reach.via} reaches ${reach.down}px down`).toBe(fieldToRow());
    expect(reach.height, `${reach.via} reaches ${reach.height}px tall`).toBe(box.height + 2 * fieldToRow());
    expect(reach.width, `${reach.via} reaches ${reach.width}px wide, room is ${widest}`).toBeLessThanOrEqual(widest);
  });

  it("renders every glyph in the row at a whole multiple of its viewBox side", () => {
    // Criterion 5, and it names a mechanism rather than the word sharp: at a
    // fractional map the coordinates the glyph was drawn on land at arbitrary
    // subpixel offsets, so the design's own alignment is lost. This is a
    // NECESSARY CONDITION AND NOT A PROOF OF CRISPNESS: these glyphs draw
    // with strokeWidth 1.5 on half unit coordinates by design, so their edges
    // sit off the device grid even at a whole map. Three of seven states
    // failed before this card: the recording microphone at 16 over 14, the
    // device chevron at 16 over 12, the gear at 24 over 16.
    const glyphs = glyphStates();
    expect(glyphs.length, "no glyph was parsed at all").toBeGreaterThan(0);
    for (const g of glyphs) {
      expect(g.px % g.side, `${g.where}: viewBox ${g.side} rendered at ${g.px}px`).toBe(0);
    }
  });

  it("counts the row's children out of the markup, so a seventh control turns this red", () => {
    // Criterion 6. The number is written nowhere else in the tree, which is
    // why it is written here: it is the one fact about the row that cannot be
    // derived from the row. Everything else in this file is.
    expect(rowChildLines()).toHaveLength(7);
  });

  it("wraps the row rather than clipping it, and a wrapped row is at most 72px", () => {
    // Criterion 7. The wrap itself is card 243's promise and
    // composerFold.drift.test.ts keeps pinning it; what is new is the height
    // it costs. `gap` in flex is both the column gap and the row gap, so a
    // second line costs one box plus one gap. It was 44 + 8 + 44 = 96.
    expect(blockOf(modal, ".composer-actions")).toMatch(/flex-wrap:\s*wrap/);
    const tallest = Math.max(...CONTROLS.map((c) => boxOf(c).height));
    expect(tallest * 2 + GAP, `${tallest} + ${GAP} + ${tallest}`).toBeLessThanOrEqual(72);
  });

  it("keeps the old gap for every child of the column and tightens only the field to the row", () => {
    // Audit 2026-09-21, section H point 2. `gap` on .composer-inner applies to
    // every child of that column, so lowering it there would hand a tighter
    // gap to any row another card puts into the column. The column keeps the
    // --sp-2 it had on 025d5107, and the one pair this card means, the field
    // and the icon row under it, moves a rung closer through a rule that
    // names both of them.
    const sp1 = SPACING.get("sp-1");
    const sp2 = SPACING.get("sp-2");
    expect(sp1, "tokens.css has no --sp-1").toBeDefined();
    expect(sp2, "tokens.css has no --sp-2").toBeDefined();
    expect(
      px(declared(blockOf(modal, ".composer-inner"), "gap"), ".composer-inner gap"),
      ".composer-inner gap, which every child of the column inherits",
    ).toBe(sp2);
    // Exactly one rule moves the row by a margin, and it is the adjacent
    // sibling rule. An unscoped `.composer-actions { margin-top }` would move
    // the row wherever it stands, which is the thing this case refuses.
    expect(rowMarginRules().map((r) => normalised(r.selector))).toEqual([FIELD_TO_ROW_SELECTOR]);
    expect(fieldToRow(), "field to row, the column gap plus the sibling margin").toBe(sp1);
  });

  it("finds exactly one icon control in each component the row mounts", () => {
    // Not a criterion of its own, but the premise the two derivations above
    // stand on. `controls()` collects every class literal naming icon-button
    // in those four files; that is the row's control list only while each file
    // holds one such button. A second one would silently add a phantom control
    // to every count in this file.
    for (const name of MOUNTED) {
      const found = CONTROLS.filter((c) => c.where === `${name}.tsx`);
      expect(found, `${name}.tsx declares ${found.length} icon controls`).toHaveLength(1);
    }
  });
});

/** Every glyph state the row can render, with its viewBox side and CSS size. */
function glyphStates(): { where: string; side: number; px: number }[] {
  const sources: [string, string][] = [
    ["Chat.tsx row", rowMarkup()],
    ...MOUNTED.map(
      (n) => [`${n}.tsx`, read(`../components/${n}.tsx`, import.meta.url)] as [string, string],
    ),
  ];
  const out: { where: string; side: number; px: number }[] = [];
  for (const [where, src] of sources) {
    for (const m of src.matchAll(/<svg\b[\s\S]{0,400}?>/g)) {
      const box = m[0].match(/viewBox="0 0 (\d+) \d+"/);
      const size = m[0].match(/width="(\d+)"/);
      if (box && size) out.push({ where, side: Number(box[1]), px: Number(size[1]) });
    }
  }
  return out;
}

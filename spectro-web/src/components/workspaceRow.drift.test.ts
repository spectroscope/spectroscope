// Card 389 criteria 1, 5 and 7 and card 428 criteria 4 and 5: where the
// working folder row is mounted and what its stylesheet promises about height,
// width and centring, read off disk.
//
// The chooser used to sit in the middle of the empty screen, inside the branch
// that renders only while `state.turns.length === 0`. Card 389 moved it into
// the live composer column, above the input box, and card 428 shows it there
// only until the first prompt starts a run (workspaceRowRender.test.tsx pins
// that behaviour on the rendered chat).
// The anchors are strings, never line numbers: the merge branches shift them.
// "composer-inner drag-over" is the live box's own ternary; the bare
// className="composer-inner" belongs to the archive bar and would accept a row
// mounted anywhere down to it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments, blockOf, read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));
const chatCss = read("../styles/chat.css", import.meta.url);

/** The index of `needle` in Chat.tsx, or a failure naming the lost anchor. */
function at(needle: string): number {
  const i = chat.indexOf(needle);
  if (i < 0) throw new Error(`Chat.tsx no longer contains ${needle}`);
  return i;
}

describe("the working folder row sits at the composer (card 389)", () => {
  it("is mounted exactly once", () => {
    // Owner call 4, default: the composer row replaces the chooser on the blank
    // screen. Two controls for one choice is the drift card 255 paid for.
    expect(chat.split("<WorkspaceChooser").length - 1).toBe(1);
  });

  it("is mounted inside the live composer column and above the input box", () => {
    const row = at("<WorkspaceChooser");
    expect(row).toBeGreaterThan(at('className="composer-column"'));
    expect(row).toBeLessThan(at('"composer-inner drag-over"'));
  });

  it("is mounted once across every source file under src, tests aside (card 428, criterion 5)", () => {
    // A second copy, for instance back on the blank screen inside the
    // `state.turns.length === 0` branch, would be a second control for one
    // choice. Test files mount the row on purpose and are not the product.
    const SRC = fileURLToPath(new URL("..", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const sources = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
    // Positive half: the walk reached the tree, including the one mounting file.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((f) => f.endsWith(join("components", "Chat.tsx")))).toBe(true);
    const mounts = sources.flatMap((f) => {
      const n = stripComments(readFileSync(f, "utf8")).split("<WorkspaceChooser").length - 1;
      return n > 0 ? [`${f.slice(SRC.length)}: ${n}`] : [];
    });
    expect(mounts).toEqual([`${join("components", "Chat.tsx")}: 1`]);
  });
});

/** chat.css with comments blanked, so a brace or a selector in prose is not code. */
const css = blankBlockComments(chatCss);

/**
 * The sheet split at its top-level at-rules: the text that applies at any
 * width, and each at-rule block with its prelude.
 */
function split(sheet: string): { top: string; blocks: { prelude: string; body: string }[] } {
  let top = "";
  const blocks: { prelude: string; body: string }[] = [];
  let i = 0;
  while (i < sheet.length) {
    const at = sheet.indexOf("@", i);
    if (at < 0) {
      top += sheet.slice(i);
      break;
    }
    top += sheet.slice(i, at);
    const open = sheet.indexOf("{", at);
    const semi = sheet.indexOf(";", at);
    if (open < 0 || (semi > -1 && semi < open)) {
      if (semi < 0) break;
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < sheet.length; j++) {
      if (sheet[j] === "{") depth++;
      else if (sheet[j] === "}" && --depth === 0) break;
    }
    blocks.push({ prelude: sheet.slice(at, open).trim(), body: sheet.slice(open + 1, j) });
    i = j + 1;
  }
  return { top, blocks };
}

const { top, blocks } = split(css);

/** The container name the row gives itself, read off its own rule. */
function rowContainerName(): string | null {
  const row = blockOf(top, ".ws-chooser");
  const short = /(?:^|[;\s])container:\s*([\w-]+)\s*\/\s*inline-size/.exec(row);
  if (short) return short[1];
  const name = /container-name:\s*([\w-]+)/.exec(row);
  return name && /container-type:\s*inline-size/.test(row) ? name[1] : null;
}

/** The row's own width queries: `@container <its name> (max-width: Npx)`. */
function rowQueries(): { max: number; body: string }[] {
  const name = rowContainerName();
  if (name === null) return [];
  const re = new RegExp(`^@container\\s+${name}\\s*\\(max-width:\\s*(\\d+(?:\\.\\d+)?)px\\)$`);
  return blocks.flatMap((b) => {
    const m = re.exec(b.prelude);
    return m ? [{ max: Number(m[1]), body: b.body }] : [];
  });
}

/** A positive length in a min-width declaration, or null. */
function floorOf(body: string): number | null {
  const m = /min-width:\s*(\d+(?:\.\d+)?)(ch|px|em|rem)\b/.exec(body);
  return m ? Number(m[1]) : null;
}

describe("the row measures itself, not the window (card 389, review 2026-09-24)", () => {
  // The row sits in .composer-column, whose width follows the side panels:
  // with the Files panel open at a 1024 px window the column is 328 px wide.
  // A viewport query cannot see that, so the row is its own container.
  it("is a named inline-size container", () => {
    expect(rowContainerName()).not.toBeNull();
  });

  it("answers to no viewport query", () => {
    const media = blocks.filter((b) => b.prelude.startsWith("@media"));
    expect(media.length).toBeGreaterThan(0);
    for (const b of media) expect(b.body, b.prelude).not.toMatch(/\.ws-chooser/);
    // The rules the row does have are still in the sheet.
    expect(top).toMatch(/\.ws-chooser-label\s*\{/);
  });

  it("drops the label and gives the folder a line of its own when the row is narrow", () => {
    const queries = rowQueries();
    expect(queries).toHaveLength(1);
    const narrow = queries[0].body;
    expect(blockOf(narrow, ".ws-chooser-label")).toMatch(/display:\s*none/);
    expect(blockOf(narrow, ".ws-chooser-line")).toMatch(/flex-direction:\s*column/);
    expect(narrow).not.toMatch(/flex-wrap:\s*wrap/);
  });
});

/** A `flex` shorthand of three parts, as grow, shrink and basis; null otherwise. */
function flexOf(body: string): { grow: number; shrink: number; basis: string } | null {
  const m = /(?:^|[;\s])flex:\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([\w.%]+)\s*(?:;|$)/.exec(body);
  return m ? { grow: Number(m[1]), shrink: Number(m[2]), basis: m[3] } : null;
}

/**
 * The narrowest one-line row that keeps the options in the middle with the
 * gone notice at its floors: options + 2 gaps + 2 x (folder floor + gap +
 * name floor + words). A snapshot of 2026-09-25, headless Chrome on stub pages
 * of the live chat with these stylesheets: German 272.52 + 16 + 2 x 219.21 =
 * 726.94 px, English 243.08 + 16 + 2 x 225.81 = 710.70 px. The readings are
 * in kanban/evidence/428/loop/browser-precheck-centre/.
 */
const CENTRED_ONE_LINE_NEED_PX = 726.94;

describe("the row is centred on the composer (card 428, review 2026-09-25)", () => {
  // The owner, 2026-09-25: "unten in der Mitte über der Chatleiste ... Wie er
  // jetzt während des Chats da ist, ja, nur halt in der Mitte." The row box
  // always spans the column, so only what is inside it can be off centre.
  // The geometry itself is measured in a browser; this is what the sheet
  // promises.
  it("gives the label and the folder equal shares on either side of the options", () => {
    const label = flexOf(blockOf(top, ".ws-chooser-label"));
    const where = flexOf(blockOf(top, ".ws-chooser-where"));
    expect(label).not.toBeNull();
    expect(where).not.toBeNull();
    expect(label!.grow).toBeGreaterThan(0);
    expect(label).toEqual(where);
    expect(label!.basis).toMatch(/^0(px|%)?$/);
  });

  it("keeps the options at their own width and puts the label against them", () => {
    const opts = blockOf(top, ".ws-chooser-opts");
    expect(opts).toMatch(/flex-shrink:\s*0/);
    expect(opts).not.toMatch(/flex(-grow)?:\s*[1-9]/);
    expect(blockOf(top, ".ws-chooser-label")).toMatch(/text-align:\s*right/);
  });

  it("centres the options and the folder on their own lines when the row is narrow", () => {
    const [narrow] = rowQueries().map((q) => q.body);
    expect(blockOf(narrow, ".ws-chooser-opts")).toMatch(/align-self:\s*center/);
    expect(blockOf(narrow, ".ws-chooser-folder")).toMatch(/text-align:\s*center/);
  });

  it("goes to two lines before the one-line row is too narrow to keep the options in the middle", () => {
    const queries = rowQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0].max).toBeGreaterThanOrEqual(CENTRED_ONE_LINE_NEED_PX);
  });
});

describe("a long path does not move the composer (card 389, criterion 7, source half)", () => {
  // The height itself is measured in a browser; jsdom lays nothing out. What
  // the stylesheet can promise is here: a reserved height and no lid on it,
  // lines that never wrap, and folder text that truncates.
  const line = (): string => blockOf(top, ".ws-chooser-line");
  const where = (): string => blockOf(top, ".ws-chooser-where");

  it("reserves the line's height rather than capping it", () => {
    expect(line()).toMatch(/(^|;|\s)min-height:/);
    expect(line()).not.toMatch(/max-height:/);
  });

  it("reserves the folder's own line even when there is nothing to name", () => {
    expect(where()).toMatch(/(^|;|\s)min-height:/);
    expect(where()).not.toMatch(/max-height:/);
  });

  it("puts a lid on no part of the row, at any width", () => {
    const rowRules = [top, ...blocks.map((b) => b.body)]
      .flatMap((sheet) => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
      .filter((m) => /\.ws-chooser/.test(m[1]));
    expect(rowRules.length).toBeGreaterThan(0);
    for (const m of rowRules) expect(m[2], m[1].trim()).not.toMatch(/max-height:/);
  });

  it("keeps the line and the folder's line from wrapping", () => {
    expect(line()).toMatch(/flex-wrap:\s*nowrap/);
    expect(where()).toMatch(/flex-wrap:\s*nowrap/);
    expect(where()).toMatch(/white-space:\s*nowrap/);
  });
});

describe("the folder in use and the gone notice keep their words (card 389, review 2026-09-24)", () => {
  // Measured 2026-09-24 at 390 px before this rule: the folder in use drew
  // 0 px wide and the sentence "ForgeDemo ist nicht mehr da" got 69.5 of the
  // 178 px it needs, clipped after the name.
  it("gives the folder in use a floor and truncates what is above it", () => {
    const folder = blockOf(top, ".ws-chooser-folder");
    expect(floorOf(folder)).toBeGreaterThan(0);
    expect(folder).toMatch(/overflow:\s*hidden/);
    expect(folder).toMatch(/text-overflow:\s*ellipsis/);
    expect(folder).toMatch(/white-space:\s*nowrap/);
  });

  it("truncates the gone folder's name down to a floor", () => {
    const name = blockOf(top, ".ws-chooser-gone-name");
    expect(floorOf(name)).toBeGreaterThan(0);
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/white-space:\s*nowrap/);
  });

  it("never shrinks the words around the name, and keeps their spaces", () => {
    const words = blockOf(top, ".ws-chooser-gone-words");
    expect(words).toMatch(/flex:\s*none|flex-shrink:\s*0/);
    expect(words).toMatch(/white-space:\s*pre\s*;/);
  });
});

describe("the stylesheet and the row name the same classes", () => {
  const component = stripComments(read("./WorkspaceChooser.tsx", import.meta.url));
  const inCss = new Set([...css.matchAll(/\.(ws-chooser[\w-]*)/g)].map((m) => m[1]));
  const inRow = new Set([...component.matchAll(/\b(ws-chooser[\w-]*)/g)].map((m) => m[1]));

  it("styles no class the row does not write", () => {
    expect(inCss.size).toBeGreaterThan(0);
    for (const c of inCss) expect(inRow, c).toContain(c);
  });

  it("writes no class the stylesheet does not style", () => {
    expect(inRow.size).toBeGreaterThan(0);
    for (const c of inRow) expect(inCss, c).toContain(c);
  });
});

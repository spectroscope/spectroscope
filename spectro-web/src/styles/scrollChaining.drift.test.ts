// A bounded well — max-height plus overflow: auto — lives INSIDE a page
// scroller: a code block in the trace detail, a thinking body in chat, a log
// pane. Its contract with the wheel is one-sided: it may consume the gesture
// while it can still scroll itself, but at its top and bottom — and when its
// content happens to fit — the rest of the gesture belongs to the page.
//
// `overscroll-behavior: contain` on such a well breaks that contract silently.
// The well still scrolls, so the rule looks harmless in review; the wheel only
// dies when the well hits an edge, which is exactly the moment the reader
// wants the page to move on. That is card 206: the trace view froze under the
// cursor over every code block, measured live on 2026-08-12 (wheel deltaY 400
// onto a well at its bottom edge, main scroller pinned; the same wheel chained
// the moment the declaration was flipped to `auto`).
//
// The full-height panel scrollers (flex: 1, no max-height — .trace-scroll,
// .chat-scroll, the sidebar) keep their `contain`: they guard the document,
// which base.css pins anyway, and they are the scroller the wells chain INTO.
// The line between the two idioms is max-height, and this guard draws it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rules } from "../testkit/source";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** @return every file under `dir`, recursively */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}



const isBoundedWell = (body: string): boolean =>
  /max-height\s*:/.test(body) && /overflow(?:-y|-x)?\s*:\s*[^;]*(auto|scroll)/.test(body);

const cutsTheChain = (body: string): boolean =>
  /overscroll-behavior(?:-y|-x)?\s*:\s*(contain|none)/.test(body);

const stylesheets = walk(SRC)
  .filter((f) => f.endsWith(".css"))
  .flatMap((f) => rules(f.slice(SRC.length), readFileSync(f, "utf8")));

const wells = stylesheets.filter((r) => isBoundedWell(r.body));

describe("a bounded well lets the wheel chain to the page at its edges", () => {
  it("still sees the wells, so an empty violation list is not a broken parser", () => {
    const selectors = wells.map((r) => r.selector);
    expect(selectors).toContain(".tv-well");
    expect(selectors).toContain(".thinking-body");
  });

  it("declares no overscroll-behavior that cuts the chain on a max-height scroller", () => {
    const violations = wells
      .filter((r) => cutsTheChain(r.body))
      .map((r) => `${r.rel}:${r.line} ${r.selector}`);
    expect(violations).toEqual([]);
  });
});

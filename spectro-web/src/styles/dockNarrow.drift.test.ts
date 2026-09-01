// Card 242's narrow-window pins, read off disk like the other style guards.
//
// Measured 2026-08-15 on a temp-home jar at the owner's ~1310px window, with
// the dock inherited open (the pre-0.9 blob + 241's browser card):
//   - `.right-panel { width: min(…, 60%) }` was a PROPORTIONAL cap: at a
//     1150px window the chat came out 356px — under the 360px reserve the
//     drag clamp (CHAT_RESERVED_MIN_WIDTH_PX, App.tsx) holds. The render-time
//     cap must be the reserve itself, not a percentage of the row.
//   - `.dock-strip { flex-wrap: wrap }` stacked the panel toggles: two lines
//     under ~500px of panel, three under ~300px, stealing rows from the cards.
//
// These are CSS-only rules; nothing but a browser or this file checks them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockOf, stripComments } from "../testkit/source";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");


describe("the chat keeps its floor beside the dock (cards 242, 361)", () => {
  it("the panel's render-time cap is the chat reserve, not a percentage", () => {
    const decls = blockOf(read("./panels.css"), ".right-panel");
    const width = decls.match(/width:\s*([^;]+);/)?.[1] ?? "";
    // The reserve, by token, plus the resizer beside the panel, also by token
    // — without the handle the floor is eaten (measured 2026-08-15: chat 352px
    // with the bare reserve).
    expect(width).toContain("calc(100% - var(--chat-reserve) - var(--row-resizer))");
    expect(width).not.toContain("60%");
  });

  it("the reserve token carries the SHIPPED default, which the settings override", () => {
    // Card 361 made the reserve a setting. The token is what the row runs on
    // until /api/settings answers, so it must equal what the code ships with —
    // App.tsx writes the resolved value over it as an inline custom property.
    const tokens = read("../tokens.css");
    const shipped = read("../state/rowWidths.ts").match(/DEFAULT_CHAT_RESERVE_PX = (\d+)/)?.[1];
    expect(shipped).toBeDefined();
    expect(tokens).toMatch(new RegExp(`--chat-reserve:\\s*${shipped}px`));
  });

  it("App writes the RESOLVED reserve over the token", () => {
    // The token is only the shipped default. Without this inline custom
    // property a raised chatReserveWidth would move the DRAG clamp and leave
    // the drawn cap at 360 — the two enforcers disagreeing again, which is the
    // defect card 242 measured and card 361 was asked to end.
    const app = stripComments(read("../App.tsx"));
    expect(app).toMatch(/"--chat-reserve":\s*`\$\{dockBounds\.reserve\}px`/);
  });

  it("both resize handlers hand the allocator what the OTHER panel takes", () => {
    // The pure allocator is bitten in rowWidths.test.ts; this pins the CALL,
    // which no test in a DOM-less suite can reach. An `occupied: 0` in either
    // handler is the two-allocator defect back in a shape that reads as wired.
    const app = stripComments(read("../App.tsx"));
    const calls = [...app.matchAll(/fitRowPanel\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    expect(calls, "the row has two resize handlers and both must allocate").toHaveLength(2);
    const [dock, gallery] = calls;
    // Each names the other's stored width, and each is conditional: a closed
    // neighbour costs the row nothing.
    expect(dock).toMatch(/occupied:[^,]*layout\.imagesW/);
    expect(dock).toMatch(/occupied:[^,]*\?/);
    expect(gallery).toMatch(/occupied:[^,]*layout\.rightPanelW/);
    expect(gallery).toMatch(/occupied:[^,]*\?/);
  });

  it("the resizer's width is ONE number, in three places that agree", () => {
    // Criterion 4 of card 361. The drag clamp used to ignore the handle while
    // the render-time cap subtracted it, so the two disagreed by exactly this
    // many pixels. Now the allocator, the token and the handle itself all read
    // the same number — and this case is what keeps them reading it.
    const px = read("../state/rowWidths.ts").match(/ROW_RESIZER_PX = (\d+)/)?.[1];
    expect(px).toBeDefined();
    expect(read("../tokens.css")).toMatch(new RegExp(`--row-resizer:\\s*${px}px`));
    expect(blockOf(read("./shell.css"), ".lab-resizer")).toMatch(/flex:\s*0 0 var\(--row-resizer\)/);
  });
});

describe("the dock strip holds one line (card 242)", () => {
  it("never wraps — overflow scrolls inside the strip", () => {
    const decls = blockOf(read("./panel-dock.css"), ".dock-strip");
    expect(decls).toMatch(/flex-wrap:\s*nowrap/);
    expect(decls).toMatch(/overflow-x:\s*auto/);
  });

  it("a toggle neither shrinks nor wraps its label", () => {
    const decls = blockOf(read("./panel-dock.css"), ".dock-toggle");
    expect(decls).toMatch(/flex:\s*none/);
    expect(decls).toMatch(/white-space:\s*nowrap/);
  });
});

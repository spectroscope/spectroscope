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
import { blockOf } from "../testkit/source";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");


describe("the chat keeps its floor beside the dock (card 242)", () => {
  it("the panel's render-time cap is the chat reserve, not a percentage", () => {
    const decls = blockOf(read("./panels.css"), ".right-panel");
    const width = decls.match(/width:\s*([^;]+);/)?.[1] ?? "";
    // The reserve, by token — the same 360 the drag clamp holds in App.tsx —
    // plus the 8px resizer beside the panel, which otherwise eats the floor
    // (measured 2026-08-15: chat 352px with the bare reserve).
    expect(width).toContain("calc(100% - var(--chat-reserve) - 8px)");
    expect(width).not.toContain("60%");
  });

  it("the reserve token is defined and carries the drag clamp's 360", () => {
    const tokens = read("../tokens.css");
    expect(tokens).toMatch(/--chat-reserve:\s*360px/);
    // The twin constant in App.tsx — one number, two enforcers. A drift here
    // means the drag and the render disagree about the chat's floor.
    const app = read("../App.tsx");
    expect(app).toMatch(/CHAT_RESERVED_MIN_WIDTH_PX = 360/);
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

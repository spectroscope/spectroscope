// Card 443: a narrow row lays the dock OVER the chat instead of squeezing it.
//
// Measured 2026-09-29 on a fresh temp-home jar of this branch before the rule
// existed, Chrome at 390 x 844: the dock came out 22px wide and each image
// card 42px, because the dock's width is `100% - reserve - resizer` and the
// chat's reserve is 360. The old image area had its own answer for a narrow
// window (`.image-panel { position: absolute }` under 900px), and that answer
// had to move into the dock with the images, or the card would take the
// pictures away from every narrow window.
//
// The threshold is the width below which the in-flow dock falls under its own
// drag floor: reserve + resizer + floor, read from rowWidths.ts rather than
// typed a second time.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockOf } from "../testkit/source";
import { DEFAULT_CHAT_RESERVE_PX, RIGHT_PANEL_MIN_PX, ROW_RESIZER_PX } from "../state/rowWidths";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the dock overlays a row too narrow to hold it beside the chat (card 443)", () => {
  const dockCss = read("./panel-dock.css");
  const threshold = DEFAULT_CHAT_RESERVE_PX + ROW_RESIZER_PX + RIGHT_PANEL_MIN_PX;

  it("the chat row is the container the rule asks", () => {
    expect(blockOf(read("./graph.css"), ".chat-row")).toMatch(/container:\s*chat-row\s*\/\s*inline-size/);
  });

  it("asks at reserve + resizer + dock floor, derived from the row's own numbers", () => {
    expect(threshold).toBe(628);
    const m = dockCss.match(/@container chat-row \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/);
    expect(m, "an @container chat-row rule in panel-dock.css").not.toBeNull();
    expect(Number(m?.[1])).toBe(threshold);
    const body = m?.[2] ?? "";
    expect(body).toMatch(/\.right-panel \{[^}]*position:\s*absolute/);
    expect(body).toMatch(/\.right-panel \{[^}]*width:\s*min\(var\(--right-panel-w[^)]*\),\s*100%\)/);
  });

  it("leaves the wide rule alone: beside the chat, capped by the reserve", () => {
    expect(blockOf(read("./panels.css"), ".right-panel")).toContain(
      "calc(100% - var(--chat-reserve) - var(--row-resizer))",
    );
  });
});

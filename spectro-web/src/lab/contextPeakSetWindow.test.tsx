// Card 390 in the lab: a run whose threshold came from the window the operator
// set for the session divides by that window, as the header ring does, and the
// note says whose window it is. Without its own note the panel would print the
// `window` sentence, "the window this run's backend stated itself", about a
// number the backend never stated.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPeak } from "./ContextPeak";
import { contextPeaks } from "./contextPeakMath";
import { setLang } from "../state/lang";
import type { RunEvent } from "../events";

afterEach(() => setLang("en"));

const events: RunEvent[] = [
  {
    type: "run_start",
    runId: "r",
    agentId: "main",
    prompt: "go",
    model: "minimax-m3:cloud",
    ts: 1,
  } as RunEvent,
  {
    type: "context_info",
    agentId: "main",
    turn: 1,
    messages: 2,
    estimatedTokens: 10,
    threshold: 358_400,
    thresholdSource: "window_override",
    contextWindow: 512_000,
    parts: [],
    ts: 2,
  } as RunEvent,
  { type: "usage", agentId: "main", inputTokens: 42_063, outputTokens: 1, ts: 3 } as RunEvent,
];

/** Markup with the escapes react-dom/server writes turned back into text. */
const plain = (html: string): string =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("the lab names the window the operator set (card 390)", () => {
  it("raises its own note and divides by the window", () => {
    const table = contextPeaks({
      spend: { main: { peak: 42_063, turns: 1 } },
      models: {},
      directory: new Map([
        [
          "main",
          { tag: "main", name: "main", parentId: null, parentRecorded: false, title: null, firstSeen: 0 },
        ],
      ]),
      reported: { threshold: 358_400, source: "window_override", window: 512_000 },
    });
    expect(table.notes).toEqual(["setWindow"]);
    expect(table.rows[0].denominator).toEqual({ value: 512_000, of: "window" });
    expect(table.rows[0].pct).toBe(8);
  });

  it("prints the sentence in English", () => {
    const html = plain(renderToStaticMarkup(<ContextPeak applied={events} />));
    expect(html).toContain(
      "Divisor: 512k, the window the operator set for this session. This run compacts below it, not at it.",
    );
    expect(html).not.toContain("the window this run's backend stated itself");
  });

  it("prints the sentence in German", () => {
    setLang("de");
    const html = plain(renderToStaticMarkup(<ContextPeak applied={events} />));
    expect(html).toContain(
      "Bezugsgröße: 512k, das Fenster, das für diese Session von Hand gesetzt wurde. " +
        "Dieser Lauf kompaktiert unterhalb davon, nicht bei diesem Wert.",
    );
  });
});

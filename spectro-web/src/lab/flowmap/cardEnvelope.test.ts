// Card 296. The envelope check had one arm and no caller.
//
// One arm: reportOversizeCards pushed only when a card rendered TALLER than
// its seat, so it was blind by construction to the opposite failure — a seat
// that reserves twice the card in it. That is the failure that shipped, and
// nothing said a word about it for two cards.
//
// No caller: the function existed nowhere in src/ outside its own test, so the
// half of the check that needs a real browser never ran at all.
//
// RE-REVIEW. The first cut of that arm was wrong twice, and both are pinned
// below. It judged the frame a card first appeared on, where a bare worker
// measures 237.59 against a 480 seat and trips the check permanently on a card
// that is about to be fine; and it judged every envelope in the table, which
// meant six standing warnings on an ordinary run. The peak is now per ENVELOPE
// and only counted once it has stood still, the arm watches the one envelope
// this card measured, and a report the run disproves is taken back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPANDED_CARD,
  UNDER_SETTLE_MS,
  UNDER_WATCHED_TYPES,
  measuredCards,
  reportOversizeCards,
  resetEnvelopeMemory,
  underfilledCards,
} from "./sceneToFlow";

const SEAT = EXPANDED_CARD.subagent.h;
const HALF = Math.floor(SEAT / 2);
const T0 = 1_700_000_000_000;

/** A worker card of height `h`, as the browser hands it over. */
const worker = (h: number, id = "w0") => ({ id, type: "subagent", h });

/** Feed a reading, then let the clock run out and read the verdict. */
const settledVerdict = (cards: { id: string; type?: string; h: number }[], t = T0) => {
  underfilledCards(cards, t);
  return underfilledCards(cards, t + UNDER_SETTLE_MS);
};

// The memory is per module — peaks and the once-only locks — so a suite that
// shares the module shares them, and one test's peak would decide the next
// test's verdict without anything going red.
beforeEach(() => {
  resetEnvelopeMemory();
});

describe("the under-fill arm", () => {
  it("names a seat that reserves at least twice the card, once the card has stood still", () => {
    expect(settledVerdict([worker(HALF)])).toEqual([{ envelope: "subagent", peak: HALF, bound: SEAT }]);
  });

  it("stays quiet for a card that fills more than half its seat", () => {
    expect(settledVerdict([worker(HALF + 1)])).toEqual([]);
  });

  // THE ORDER A REAL RUN HAS, and the one the first cut could not survive. A
  // bare worker card measures 237.59 world px (cardGeometry's own table) and
  // 237 * 2 <= 480, so the check fired on the very frame a worker was laid
  // out. No peak map can rescue that: the FIRST reading IS the peak, and the
  // card only grows afterwards. A settled reading can.
  it("stays silent on the frame a bare worker is first laid out", () => {
    expect(underfilledCards([worker(237)], T0)).toEqual([]);
    // it picks up its tool panel well inside the window, and the peak moving
    // restarts the clock
    expect(underfilledCards([worker(304)], T0 + 400)).toEqual([]);
    // settled now, at the typical 304 — and 304 fills more than half of 480
    expect(underfilledCards([worker(304)], T0 + 400 + UNDER_SETTLE_MS)).toEqual([]);
  });

  // The settle window is a window on the PEAK, not on the envelope: found by
  // biting it. Anchoring `since` to the first sighting instead of the last
  // growth left every test above green, because the cards they climb to are
  // over half the seat anyway. A card that climbs and stays under half is the
  // case that tells the two apart.
  it("restarts the clock when the peak grows — a card still filling up is not a settled one", () => {
    expect(underfilledCards([worker(120)], T0)).toEqual([]);
    expect(underfilledCards([worker(200)], T0 + UNDER_SETTLE_MS)).toEqual([]);
    expect(underfilledCards([worker(200)], T0 + UNDER_SETTLE_MS * 2)).toEqual([
      { envelope: "subagent", peak: 200, bound: SEAT },
    ]);
  });

  // The docstring this replaces promised exactly this case in so many words —
  // "a run whose first worker is bare and whose second carries four pictures"
  // — and that sentence is about two DIFFERENT ids, which a per-id peak map
  // can say nothing about. One seat shape, one peak.
  it("takes the tallest card of the TYPE, not of one id — the pictures arrive on the SECOND worker", () => {
    underfilledCards([worker(237, "w0")], T0);
    const late = T0 + UNDER_SETTLE_MS * 3;
    // w0 is bare and has been settled for three windows; w1 carries the four
    // attached pictures of the owner's own transcript, 423 world px.
    expect(underfilledCards([worker(237, "w0"), worker(423, "w1")], late)).toEqual([]);
    expect(underfilledCards([worker(237, "w0"), worker(423, "w1")], late + UNDER_SETTLE_MS)).toEqual([]);
  });

  // A report that can never be withdrawn is worse than no report: the reader
  // learns to ignore the channel, which is the failure this whole check exists
  // to undo. A worker that sits bare past the window and only then picks up a
  // tool is an ordinary run, not a corner case.
  it("withdraws a report the run goes on to disprove, and then holds its peace", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportOversizeCards([worker(237)], sink, T0);
    reportOversizeCards([worker(237)], sink, T0 + UNDER_SETTLE_MS);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("237px");
    reportOversizeCards([worker(304)], sink, T0 + UNDER_SETTLE_MS + 10);
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("withdrawing");
    expect(said[1]).toContain("304px");
    reportOversizeCards([worker(304)], sink, T0 + UNDER_SETTLE_MS * 5);
    expect(said).toHaveLength(2);
  });

  // Live on the "scaling fan-out" scenario the arm named FIVE more seats at
  // once — agent 364 against 780, llm 168 against 540, os-shell 65 against
  // 340, os-mcp 65 against 340, os-disk 104 against 240. Every reading is TRUE
  // and none of them is broken, so an arm that watched them all would ship
  // already shouting and bury the first real finding exactly the way the
  // missing caller buried it. Card 296 corrected one envelope; the arm watches
  // that one, and widening it belongs to whichever card corrects the next.
  it("watches only the envelope this card measured", () => {
    expect([...UNDER_WATCHED_TYPES]).toEqual(["subagent"]);
    expect(
      settledVerdict([
        { id: "agent", type: "agent", h: 364 },
        { id: "llm", type: "llm", h: 168 },
        { id: "os-disk", type: "os-disk", h: 104 },
      ]),
    ).toEqual([]);
  });

  it("ignores a card the browser has not measured yet", () => {
    expect(settledVerdict([worker(0)])).toEqual([]);
  });

  // The two arms do not shout at the same volume, and this pins the split in
  // both directions at once: the OVER arm is unscoped and catches the agent
  // hub, the under arm is scoped and does not.
  it("routes the two arms to error and warn, so a smell is not read as a defect", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cards = [{ id: "agent", type: "agent", h: EXPANDED_CARD.agent.h + 40 }, worker(40)];
    reportOversizeCards(cards, undefined, T0);
    reportOversizeCards(cards, undefined, T0 + UNDER_SETTLE_MS);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("agent card rendered")]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("tallest subagent")]);
    err.mockRestore();
    warn.mockRestore();
  });

  it("reports through the same sink as the oversize arm, once", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportOversizeCards([worker(40)], sink, T0);
    const r = reportOversizeCards([worker(40)], sink, T0 + UNDER_SETTLE_MS);
    reportOversizeCards([worker(40)], sink, T0 + UNDER_SETTLE_MS * 2);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("subagent");
    expect(said[0]).toContain(String(SEAT));
    expect(r.under).toEqual([{ envelope: "subagent", peak: 40, bound: SEAT }]);
    expect(r.over).toEqual([]);
  });
});

describe("the runtime half has a caller", () => {
  const src = readFileSync(new URL("../FlowMap.tsx", import.meta.url), "utf8");
  const rendered = [
    { id: "z-mac", type: "zone", measured: { height: 900 } },
    { id: "sub-a", type: "subagent", measured: { height: 300 } },
    { id: "sub-b", type: "subagent" },
    { id: "agent", type: "agent", measured: { height: 0 } },
  ];

  it("turns rendered nodes into what the check reads, zones and unmeasured out", () => {
    expect(measuredCards(rendered, true)).toEqual([{ id: "sub-a", type: "subagent", h: 300 }]);
  });

  it("says nothing about the compact seating — no card there is derived from this table", () => {
    expect(measuredCards(rendered, false)).toEqual([]);
  });

  // The pin moved with the caller (re-review). One call is no longer enough:
  // this effect fires while a worker card is still filling up, and the under
  // arm can only speak on a layout that has stopped moving — so the caller
  // reports now AND once more after the quiet window, cancelling the pending
  // one on every change. Each half is bitten on its own.
  it("FlowMap calls it on the spot — a card over its seat is drawing over its neighbour", () => {
    expect(src).toContain("const cards = measuredCards(nodes, expandAll);");
    expect(src).toContain("reportOversizeCards(cards);");
  });

  it("FlowMap calls it again once the layout has stood still — the under arm's only chance", () => {
    expect(src).toContain("const settled = setTimeout(() => reportOversizeCards(cards), UNDER_SETTLE_MS);");
    expect(src).toContain("return () => clearTimeout(settled);");
  });
});

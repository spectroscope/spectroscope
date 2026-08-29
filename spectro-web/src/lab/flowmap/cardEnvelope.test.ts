// Card 296. The envelope check had one arm and no caller.
//
// One arm: reportOversizeCards pushed only when a card rendered TALLER than
// its seat, so it was blind by construction to the opposite failure — a seat
// that reserves twice the card in it. That is the failure that shipped, and
// nothing said a word about it for two cards.
//
// No caller: the function existed nowhere in src/ outside its own test, so the
// half of the check that needs a real browser never ran at all.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXPANDED_CARD, measuredCards, reportOversizeCards, underfilledCards } from "./sceneToFlow";

describe("the under-fill arm", () => {
  it("names a seat that reserves at least twice the card standing in it", () => {
    const half = Math.floor(EXPANDED_CARD.subagent.h / 2);
    expect(underfilledCards([{ id: "u-under", type: "subagent", h: half }])).toEqual([
      { id: "u-under", h: half, bound: EXPANDED_CARD.subagent.h },
    ]);
  });

  it("stays quiet for a card that fills more than half its seat", () => {
    const half = Math.floor(EXPANDED_CARD.subagent.h / 2);
    expect(underfilledCards([{ id: "u-ok", type: "subagent", h: half + 1 }])).toEqual([]);
  });

  it("judges the TALLEST card the seat ever held, not the last one measured", () => {
    // A run whose first worker is bare and whose second carries pictures must
    // not be reported as under-filled on the strength of the bare one.
    const full = EXPANDED_CARD.subagent.h - 10;
    underfilledCards([{ id: "u-peak", type: "subagent", h: full }]);
    expect(underfilledCards([{ id: "u-peak", type: "subagent", h: 10 }])).toEqual([]);
  });

  it("ignores a card the browser has not measured yet", () => {
    expect(underfilledCards([{ id: "u-zero", type: "subagent", h: 0 }])).toEqual([]);
  });

  it("reports through the same sink as the oversize arm, once", () => {
    const said: string[] = [];
    const measured = [{ id: "u-said", type: "subagent", h: 40 }];
    const r = reportOversizeCards(measured, (m) => said.push(m));
    reportOversizeCards(measured, (m) => said.push(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("u-said");
    expect(said[0]).toContain(String(EXPANDED_CARD.subagent.h));
    expect(r.under.map((c) => c.id)).toEqual(["u-said"]);
    expect(r.over).toEqual([]);
  });
});

describe("the runtime half has a caller", () => {
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

  it("FlowMap calls it — the defect was that nothing did", () => {
    const src = readFileSync(new URL("../FlowMap.tsx", import.meta.url), "utf8");
    expect(src).toContain("reportOversizeCards(measuredCards(nodes, expandAll));");
  });
});

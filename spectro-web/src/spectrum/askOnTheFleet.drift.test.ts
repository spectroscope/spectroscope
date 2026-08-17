// Card 265, the concept's §3.5: the ask on the two FLEET surfaces.
//
// "a `pendingAsk` lane flag beside the existing gate flag, and an ask tick. In
// fleet mode that is the view that sells the feature — five agents on the bus,
// one is waiting for you."
//
// The folds are pure and pinned next door (spectrumModel.test.ts,
// fleetGraph.test.ts, fleetLegibility.test.ts). What no test in a suite without a
// DOM can see is the .tsx line that DRAWS the flag — and a flag nobody draws is
// precisely the failure §6.5 of the concept names: "A new event type that one view
// does not know about is invisible on that view. That is the wasted-capability
// failure this whole document exists to avoid." So these read the two views off
// disk, each as one statement, the way card 247's sharpened pin has to be read.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { dict } from "../i18n/i18n";

const view = stripComments(read("./SpectrumView.tsx", import.meta.url));
const band = stripComments(read("./SpectrumBand.tsx", import.meta.url));
const canvas = stripComments(read("./FleetCanvas.tsx", import.meta.url));
const spectrumCss = read("../styles/spectrum.css", import.meta.url);
const fleetCss = read("../styles/fleet.css", import.meta.url);

/** The single statement that starts at `needle`, up to its own semicolon. */
function statement(source: string, needle: string): string {
  const from = source.indexOf(needle);
  expect(from, `${needle} is not in the source at all`).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf(";", from));
}

describe("the lane says a person is holding it", () => {
  it("SpectrumView draws the ask flag off the lane's own field", () => {
    expect(statement(view, "lane.pendingAsk &&")).toContain("sp.askOpen");
  });

  it("and it stays a SECOND flag, next to the gate's, never a replacement", () => {
    expect(view).toContain("lane.pendingGate &&");
    expect(view).toContain("lane.pendingAsk &&");
  });

  it("the band has a shape and a colour for the ask mark", () => {
    // Both are Records over TickKind, so a missing entry is a compile error
    // rather than a silent hole — this only pins that the colour is a TOKEN.
    expect(statement(band, "ask: { w:")).toContain("h:");
    expect(statement(band, 'ask: "var(')).toContain("var(--ev-");
  });

  it("the flag's word exists in both languages, so colour is never the meaning", () => {
    expect(dict["sp.askOpen"]).toBeDefined();
    expect(dict["sp.askOpen"].de).not.toBe("");
    expect(dict["sp.askOpen"].en).not.toBe("");
    expect(dict["sp.askOpen"].de).not.toBe(dict["sp.askOpen"].en);
  });

  it("the ask flag's colour comes from a token, never from a literal", () => {
    const rule = spectrumCss.slice(spectrumCss.indexOf(".spectrum-ask"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("var(--");
    expect(rule.slice(0, rule.indexOf("}"))).not.toMatch(/#[0-9a-fA-F]{3}/);
  });
});

describe("the fleet card says which agent stopped the fleet", () => {
  it("FleetCanvas puts the ask class on the node that carries the flag", () => {
    expect(statement(canvas, "node.pendingAsk ?")).toContain("fleet-node-card--ask");
  });

  it("the class exists in the sheet and takes its colour from a token", () => {
    const rule = fleetCss.slice(fleetCss.indexOf(".fleet-node-card--ask"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("var(--");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3}/);
  });
});

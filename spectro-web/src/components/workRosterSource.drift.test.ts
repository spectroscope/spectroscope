// Card 313, the wiring: ONE roster feeds both panels.
//
// The pure decision is pinned in workAgentsInStream.test.tsx. What that cannot
// see is where the array comes from — and the defect this card repairs was
// never a wrong rule, it was two readings of one fact. A second array handed
// to the work panel would satisfy every assertion over there and reproduce the
// disagreement here, on the screen, where the owner found it.
//
// Comments are blanked first: the prose above these lines quotes the very
// shapes the assertions look for, and a blanker that missed them would let a
// COMMENT pass for CODE.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const right = stripComments(read("./RightPanel.tsx", import.meta.url));
const panel = stripComments(read("./WorkPanel.tsx", import.meta.url));

/** The dock's body switch, where each panel is handed its data. */
function bodyFor(src: string): string {
  const from = src.indexOf("const bodyFor");
  expect(from).toBeGreaterThan(-1);
  return src.slice(from, src.indexOf('case "plan":', from));
}

describe("both panels read one roster", () => {
  it("the dock hands the work panel the very array the agents tab renders", () => {
    const body = bodyFor(right);
    expect(body).toContain("roster={agents}");
    expect(body).toContain("<AgentsTab agents={agents}");
  });

  it("the work panel asks workLevels, rather than deciding presence inline", () => {
    expect(panel).toContain("besideReading(item, roster, sidecars)");
  });

  it("the absences line hangs off that same reading", () => {
    // Two conditions over one fact is how the panel came to contradict its
    // neighbour; the second one is gone, not merely agreed with.
    expect(panel).toContain('absences(item, reading?.kind === "inStream")');
  });

  it("nothing in the panel reaches past the reading to the sidecar index", () => {
    // The file list is drawn out of `reading.files`, so a row can no longer
    // name a transcript that the reading has already accounted for as loaded.
    expect(panel).not.toContain("sidecars.forRun");
  });
});

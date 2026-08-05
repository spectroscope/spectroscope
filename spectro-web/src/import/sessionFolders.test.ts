import { describe, expect, it } from "vitest";
import { folderLabelKey, shownFolders, type SessionFolder } from "./sessionFolders";

const f = (kind: string): SessionFolder => ({ kind, path: `/tmp/${kind}` });

describe("the folders a session left on disk", () => {
  it("draws them in the order a reader wants them", () => {
    const out = shownFolders([f("scratchpad"), f("workflows"), f("transcript")]);
    expect(out.map((x) => x.kind)).toEqual(["transcript", "workflows", "scratchpad"]);
  });

  it("offers only what the server said is there", () => {
    expect(shownFolders([f("transcript")]).map((x) => x.kind)).toEqual(["transcript"]);
    expect(shownFolders([])).toEqual([]);
  });

  // A newer server may name a folder this build has no sentence for. Rendering
  // the raw wire word would put "scratchpad_v2" on a button.
  it("drops a kind it has no words for rather than printing the wire word", () => {
    expect(shownFolders([f("transcript"), f("something-new")]).map((x) => x.kind)).toEqual(["transcript"]);
    expect(folderLabelKey("something-new")).toBeNull();
  });

  it("has a label for each of the three", () => {
    for (const kind of ["transcript", "workflows", "scratchpad"]) {
      expect(folderLabelKey(kind)).not.toBeNull();
    }
  });
});

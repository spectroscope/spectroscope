// The header's eyebrow names what you are looking at. Three kinds of replay
// reach it and they are not the same thing, so they must not share a word.
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { replayEyebrow } from "./replayEyebrow";

describe("replayEyebrow", () => {
  it("calls an import an import, not an archive", () => {
    // The defect: a Claude Code transcript loaded from another tool's file was
    // labelled "Archive", which is what a session THIS machine produced and
    // stored is called. Same word, two meanings, one of them false.
    expect(replayEyebrow("import:claude-code:session.jsonl")).toBe("hdr.imported");
    expect(replayEyebrow("import:vscode-agent:export.jsonl")).toBe("hdr.imported");
    expect(replayEyebrow("import:spectroscope:pasted session")).toBe("hdr.imported");
  });

  it("still calls a scenario a scenario and a stored session an archive", () => {
    expect(replayEyebrow("scenario:fanout")).toBe("hdr.scenario");
    expect(replayEyebrow("20260726-172215")).toBe("hdr.archive");
  });

  it("never returns a key the dictionary does not carry", () => {
    for (const id of ["import:claude-code:x", "scenario:x", "20260726-172215"]) {
      expect(dict[replayEyebrow(id)], id).toBeDefined();
    }
  });
});

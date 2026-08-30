// The seam between the run endpoint's answer and the merge that was already
// tested. Card 318.
//
// The server writes the importer's own field names — `sessionText`,
// `sidecars[].jsonlText`, `sidecars[].metaJson`, `sidecars[].runId`,
// `runStates[].runId`, `runStates[].json` — so there is nothing to translate.
// What is left is what every reader of an HTTP body owes: the body is untrusted
// input, and a dialog that throws a TypeError on a shape it did not expect is a
// dialog that stops working with no sentence for the reader.
//
// The refusal is parsed here too, and it is the reason the 413 carries JSON
// rather than the prose /content answers with: the row prints those two numbers
// as its own sentence, in the reader's own language.

import { describe, expect, it } from "vitest";

import { runBundleInput, runRefusal } from "./runBundle";

const SIDECAR = { agentId: "a1", runId: "wf_1", jsonlText: "{}\n", metaJson: '{"spawnDepth":1}' };

describe("the run bundle reaches the importer as the importer's own inputs", () => {
  it("carries the three text sets through, verbatim", () => {
    const input = runBundleInput({
      path: "-Users-x/s1.jsonl",
      sessionText: '{"type":"user"}\n',
      sidecars: [SIDECAR],
      runStates: [{ runId: "wf_1", json: '{"status":"completed"}' }],
    });

    expect(input.sessionText).toBe('{"type":"user"}\n');
    expect(input.sidecars).toEqual([
      { jsonlText: SIDECAR.jsonlText, metaJson: SIDECAR.metaJson, runId: "wf_1" },
    ]);
    expect(input.runStates).toEqual([{ runId: "wf_1", json: '{"status":"completed"}' }]);
  });

  it("a direct spawn carries NO runId key, rather than a null one", () => {
    // `SidecarText.runId` is optional and a null is not the same value: the
    // coordinator asks whether the field is there, and a null would answer yes.
    const [only] = runBundleInput({
      sessionText: "",
      sidecars: [{ agentId: "a1", jsonlText: "x", metaJson: "" }],
    }).sidecars;

    expect(only).toEqual({ jsonlText: "x", metaJson: "" });
    expect("runId" in only).toBe(false);
  });

  it("a body that is not the shape yields empty sets, never a throw", () => {
    // A session with nothing beside it answers empty arrays, so "nothing" is a
    // real reading here and must not be distinguishable from a broken answer by
    // the dialog blowing up. Both leave the reader with the session itself.
    for (const body of [null, undefined, 7, "no", {}, { sidecars: 3, runStates: "x" }]) {
      const input = runBundleInput(body);
      expect(input.sessionText).toBe("");
      expect(input.sidecars).toEqual([]);
      expect(input.runStates).toEqual([]);
    }
  });

  it("drops a sidecar row that has no text where its text belongs", () => {
    const input = runBundleInput({
      sessionText: "s",
      sidecars: [{ agentId: "a1" }, SIDECAR],
      runStates: [{ runId: "wf_1" }, { json: "{}" }],
    });

    expect(input.sidecars).toHaveLength(1);
    expect(input.runStates).toEqual([]);
  });
});

describe("the refusal names both numbers or says nothing", () => {
  it("reads what the run weighed and what the server carries", () => {
    expect(runRefusal({ totalBytes: 109_063_005, limitBytes: 134_217_728 })).toEqual({
      totalBytes: 109_063_005,
      limitBytes: 134_217_728,
    });
  });

  it("a refusal missing either number is not a sentence, and says so with null", () => {
    // The row's degrade sentence prints BOTH numbers. Half of it would be a
    // worse line than the plain status, so this answers null and the caller
    // falls back to the ordinary fetch error.
    expect(runRefusal({ totalBytes: 5 })).toBeNull();
    expect(runRefusal({ limitBytes: 5 })).toBeNull();
    expect(runRefusal("413")).toBeNull();
  });
});

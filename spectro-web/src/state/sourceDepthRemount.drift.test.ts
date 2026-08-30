// Card 326 re-review: the remount that makes "the master WINS" true.
//
// sourceDepth.test.ts pins that the epoch BUMPS. The bump is inert on its own:
// the epoch only moves a node that a reader already folded shut if it reaches
// the source pane's React `key`, because JsonTree reads `defaultDepth` at mount
// and never again. All three reviewers measured the same thing — replace
// TraceView's `key={`depth-${depthPref.epoch}`}` with a constant and the whole
// web suite stays green at 397 files and 5776 tests, while the promise the
// dictionary makes to the reader ("Every level open, including the nodes you
// folded shut yourself" / "auch die Knoten, die du selbst zugeklappt hast")
// quietly stops holding.
//
// So the mechanism gets a NAME in the module that argues for it, and two
// halves that fail for two different reasons:
//
//   the key itself   pure, behavioural — a key that does not move with the
//                    epoch remounts nothing, whatever the pane does with it
//   the pane's use   read off TraceView.tsx, because this gate has no DOM and
//                    a React key is not in the rendered markup at all
//
// WHAT IS STILL NOT PINNED HERE, said plainly rather than in a test name: that
// React then rebuilds the subtree. That is React's contract, not this repo's,
// and checking it needs a DOM this suite does not have. It was verified live
// instead — hand-fold a node, press verbose, watch it come back open — and
// with the epoch out of the key the same node stayed shut.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { sourcePaneKey } from "./sourceDepth";

const traceView = stripComments(read("../components/TraceView.tsx", import.meta.url));

describe("the key the source pane is mounted under", () => {
  it("is a different key after the master moves", () => {
    expect(sourcePaneKey({ depth: "default", epoch: 0 })).not.toBe(
      sourcePaneKey({ depth: "verbose", epoch: 1 }),
    );
  });

  it("moves on the EPOCH, not on the level", () => {
    // The level is what a node reads once it is born; the epoch is what makes
    // it be born again. A key built from the level alone would collapse
    // default → verbose → default onto two keys, and the second press would
    // hand every hand-folded node straight back.
    expect(sourcePaneKey({ depth: "default", epoch: 2 })).not.toBe(
      sourcePaneKey({ depth: "default", epoch: 3 }),
    );
  });

  it("is the same key while the master stands still", () => {
    // A key that changed on every render would remount the tree under the
    // reader's hands and lose every fold they made, which is the opposite
    // defect and just as invisible from here.
    expect(sourcePaneKey({ depth: "verbose", epoch: 4 })).toBe(
      sourcePaneKey({ depth: "verbose", epoch: 4 }),
    );
  });
});

describe("the source pane is actually mounted under it", () => {
  /** The `<SourceBody …/>` element in TraceView, props text only. */
  function sourceBodyMount(): string {
    const at = traceView.indexOf("<SourceBody");
    expect(at, "TraceView no longer mounts SourceBody at all").toBeGreaterThan(-1);
    return traceView.slice(at, traceView.indexOf("/>", at));
  }

  it("keys the pane on the depth master", () => {
    expect(sourceBodyMount()).toContain("key={sourcePaneKey(depthPref)}");
  });

  it("mounts the pane exactly once, so no second one escapes the key", () => {
    expect(traceView.split("<SourceBody")).toHaveLength(2);
  });
});

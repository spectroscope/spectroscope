// Card 326 re-review: the one hop that decides a whole session's toolbar.
//
// traceFaceOrigin.test.ts already calls this seam "the one hop nothing else
// stands over" and then pins `traceOriginOf` — the FUNCTION — and stops. The
// re-review measured what that leaves open: replacing both of App's
// `origin={traceOriginOf(replay?.kind, enteredFleet)}` with `origin="native"`
// turns every import back into a native session, which is the whole of this
// card's user-visible behaviour, and the full suite stayed green at 397 files
// and 5776 tests. Dropping `kind,` from openImport's setReplay does the same
// thing one step earlier, and was equally invisible.
//
// WHAT THIS FILE IS AND IS NOT. It reads App.tsx off disk, the way
// state/traceSeam.drift.test.ts reads the same file's two trace mounts and for
// the same reason: this gate has no DOM and App is not a component a suite
// mounts. So it pins that the wiring is WRITTEN, not that it runs. The half
// that runs — which faces each origin then offers, and which buttons the view
// draws for them — is behaviour, and it is pinned as behaviour in
// traceOriginRule.test.ts and components/traceToolbarFaces.test.tsx. Neither
// of those can see an App that never asks.
//
// Comments are blanked before anything is matched, so the prose above cannot
// satisfy an assertion about the code below it.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { IMPORT_KINDS } from "../import/detect";

const app = stripComments(read("../App.tsx", import.meta.url));

/** Every `<TraceView …/>` in App.tsx, props text only — traceSeam's own walk,
 *  which exists because the first version of that file pinned one mount and
 *  walked straight past the other one, and the other one was wrong. */
function traceMounts(): string[] {
  const out: string[] = [];
  for (let at = app.indexOf("<TraceView"); at !== -1; at = app.indexOf("<TraceView", at + 1)) {
    out.push(app.slice(at, app.indexOf("/>", at)));
  }
  return out;
}

describe("the trace is told where its frames came from", () => {
  it("every mount asks traceOriginOf, with both facts", () => {
    // Both arguments named, not just the call: `traceOriginOf(replay?.kind)`
    // would compile, would look right, and would give an entered fleet the
    // import's face list — other processes' frames under a foreign file's
    // toolbar.
    const mounts = traceMounts();
    expect(mounts.length).toBeGreaterThan(0);
    for (const props of mounts) {
      expect(props, "a TraceView mount that decides the origin some other way").toContain(
        "origin={traceOriginOf(replay?.kind, enteredFleet)}",
      );
    }
  });

  it("the format an import was read from is kept, or there is nothing to ask with", () => {
    // openImport takes `kind` and has to put it on the replay record; without
    // it `replay?.kind` is forever undefined and traceOriginOf answers
    // "native" for every file in the app.
    const from = app.indexOf("const openImport");
    expect(from).toBeGreaterThan(-1);
    const openImport = app.slice(from, app.indexOf("\n  };", from));
    expect(openImport).toContain("kind,");
  });

  it("a face list is never built from the replay's display label", () => {
    // The id carries a filename (`import:${kind}:${label}`) and reads like an
    // answer. Deriving a behavioural switch from a formatted string is what
    // traceFace.ts's header argues against, so no mount may pass one.
    for (const props of traceMounts()) {
      expect(props).not.toMatch(/origin=\{[^}]*replay\?\.id/);
    }
  });

  it("no mount hard-codes a format the importer reads", () => {
    // A literal origin is how this seam died under mutation: it type-checks,
    // it renders, and it silently answers for every session in the app.
    for (const props of traceMounts()) {
      for (const kind of IMPORT_KINDS) {
        expect(props, `${kind} written into a mount instead of measured`).not.toContain(
          `origin="${kind}"`,
        );
      }
      expect(props).not.toContain('origin="native"');
    }
  });
});

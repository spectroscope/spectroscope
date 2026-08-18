// The 250 ms floor under the fold is only a floor if the shell lets it be one.
//
// Card 261 review. flushPump.ts arms a plain timer beside the animation frame
// so a window nobody is looking at folds anyway. In a browser that is the end
// of it. In Electron it is not: with `backgroundThrottling` at its default
// (true), Chromium clamps setTimeout in a hidden or minimised window to a
// second or more, and after about five minutes hidden to roughly once a
// minute. The fix would still beat "never folds", but the card's promise — a
// window brought back to the front is current instead of replaying minutes —
// would not hold in the shell the owner actually uses, and the buffer would go
// on growing between folds.
//
// browserPane.ts already turns throttling off for the session pane, and says
// why. This is the same argument for the window the operator watches. Two
// projects, two build systems, no shared module: the same situation
// browserMarker.drift.test.ts is in, and the same answer — a test that reads
// the other project's source and refuses the drift.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HIDDEN_FLUSH_MS } from "./flushPump";

const desktop = (file: string): string =>
  readFileSync(path.join(__dirname, "..", "..", "..", "spectro-desktop", "src", file), "utf8");

const main = desktop("main.ts");

describe("the desktop shell and the fold floor", () => {
  it("does not let Chromium throttle the app window's timers", () => {
    // Not a grep for the string anywhere in the file: it has to be inside the
    // webPreferences of the window createWindow builds, which is the only
    // window the operator's session is rendered in.
    const opened = main.indexOf("function createWindow(");
    expect(opened).toBeGreaterThan(-1);
    const preferences = main.slice(opened, main.indexOf("}", main.indexOf("webPreferences", opened)));
    expect(preferences).toContain("backgroundThrottling: false");
  });

  it("agrees with the pane that already turns it off", () => {
    // If the session pane needs it off to keep answering while hidden, the
    // window carrying the live view needs it off to keep folding while hidden.
    expect(desktop("browserPane.ts")).toContain("backgroundThrottling: false");
  });

  it("is the setting the 250 ms fallback depends on", () => {
    // A reminder in the failure output rather than a second fact: the number
    // this drift protects lives in flushPump.ts.
    expect(HIDDEN_FLUSH_MS).toBe(250);
  });
});

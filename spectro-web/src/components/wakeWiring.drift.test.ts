// Card 498: the wake's wiring in App, which no unit test reaches.
//
// The pure parts (wakeChip.ts, the session set's wake record, the chip's gone
// state) are pinned on their own. What stays is the seam: the message box
// reports its focus, App turns that focus into a wake of the stored session on
// screen, the header reads the chip through headerWorkspace, and the first
// message continues on the woken socket instead of opening a second one that
// the server would refuse.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));
const lab = stripComments(read("../lab/LabView.tsx", import.meta.url));

describe("the wake's wiring", () => {
  it("the message box reports its focus", () => {
    expect(chat).toContain("onFocus={props.onComposerFocus}");
  });

  it("App wakes the stored session on that focus", () => {
    expect(app).toContain("onComposerFocus: wakeStored,");
    expect(app).toMatch(
      /const wakeStored = \(\): void => \{[\s\S]*?sessions\.open\(\{ wake: replay\.id \}\);/,
    );
  });

  it("the header chip is the stored folder, then the wake's answer", () => {
    expect(app).toMatch(
      /workspace=\{headerWorkspace\(\{[\s\S]*?woken: wokenSlot\?\.state\.workspace \?\? null,/,
    );
  });

  it("the folder of a stored session cannot be changed from the chip", () => {
    expect(app).toContain("canPickFolder={viewingLive && canPickWorkspace}");
  });

  it("the first message continues on the woken socket", () => {
    expect(app).toMatch(/if \(woken !== undefined\) \{\s*sessions\.continueWoken\(woken\.key,/);
  });

  it("a session this page woke is its own, never live elsewhere", () => {
    expect(app).toContain("const ownIds = ownSessionIds(heldRows, allSlots);");
  });

  it("a wake is let go when the stored session leaves the screen", () => {
    expect(app).toMatch(
      /if \(held\.woken && held\.sessionId !== replayOnScreen\) sessions\.close\(held\.key\);/,
    );
  });

  it("the Lab's message box wakes the stored session too, through the same Chat", () => {
    expect(lab).toMatch(/<Chat\b[\s\S]*?onComposerFocus=\{props\.onComposerFocus\}[\s\S]*?\/>/);
    expect(app).toMatch(/<LabView\b[\s\S]*?onComposerFocus=\{wakeStored\}[\s\S]*?\/>/);
  });
});

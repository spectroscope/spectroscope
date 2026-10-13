// Card 554, task 13: App's two decisions about the playbook that are not a
// frame. Which pick the header chip draws: the live session's, else for a
// stored session that the next message continues the wake's answer and,
// before it, the pick its own file recorded (integrator decision e); a
// read-only archive draws no chip. And what has to move so the composer is on
// screen when the play button writes into it (criterion 4).

import { describe, expect, it } from "vitest";
import { composerMoves, headerPlaybook } from "./playbookHost";
import type { PlaybookPick } from "./playbookChat";

const RECORDED: PlaybookPick = { dir: "/pb/a", name: "A", found: null };
const WOKEN: PlaybookPick = { dir: "/pb/a", name: "A", found: true };
const LIVE: PlaybookPick = { dir: "/pb/b", name: "B", found: true };

describe("the pick the header chip draws", () => {
  it("is the live session's in the live view", () => {
    const at = {
      viewingLive: true,
      livePick: LIVE,
      continuable: false,
      replayPick: RECORDED,
      wokenPick: WOKEN,
    };
    expect(headerPlaybook(at)).toEqual({ pick: LIVE });
    expect(headerPlaybook({ ...at, livePick: null })).toEqual({ pick: null });
  });

  it("is a stored session's recorded pick before the wake, and the wake's answer after it", () => {
    const at = {
      viewingLive: false,
      livePick: LIVE,
      continuable: true,
      replayPick: RECORDED,
      wokenPick: null,
    };
    expect(headerPlaybook(at)).toEqual({ pick: RECORDED });
    expect(headerPlaybook({ ...at, wokenPick: WOKEN })).toEqual({ pick: WOKEN });
  });

  it("is no chip for an archive that stays read only", () => {
    expect(
      headerPlaybook({
        viewingLive: false,
        livePick: LIVE,
        continuable: false,
        replayPick: RECORDED,
        wokenPick: null,
      }),
    ).toBeNull();
  });
});

describe("bringing the composer on screen for the play button", () => {
  it("moves nothing when the chat or the Lab is showing", () => {
    expect(composerMoves({ skillsOpen: false, nav: "sessions", tab: "chat" })).toEqual({
      segment: false,
      tab: false,
    });
    expect(composerMoves({ skillsOpen: false, nav: "sessions", tab: "lab" })).toEqual({
      segment: false,
      tab: false,
    });
  });

  it("goes back to the sessions from the Playbook view, the Skills view and another tab", () => {
    expect(composerMoves({ skillsOpen: false, nav: "playbook", tab: "chat" })).toEqual({
      segment: true,
      tab: false,
    });
    expect(composerMoves({ skillsOpen: true, nav: "sessions", tab: "chat" }).segment).toBe(true);
    expect(composerMoves({ skillsOpen: false, nav: "sessions", tab: "trace" })).toEqual({
      segment: false,
      tab: true,
    });
  });
});

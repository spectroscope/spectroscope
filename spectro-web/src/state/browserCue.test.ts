// The cue that tells the browser view an AGENT drove the browser (card 226).
//
// The screencast follows the page the viewer watched; an agent-driven
// navigation mid-watch does not restart it by itself (a core-half disclosure,
// pinned in docs/BROWSER.md). The session's own browser_action RunEvents are
// the announcement, so the app counts them and the segment re-issues `watch`
// when the count moves. The count is the WHOLE contract: no payload rides
// here, because the state frame the re-watch answers with carries the truth.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { browserCueCount, browserCuePushLive } from "./browserCue";

const action = (cid: string): RunEvent =>
  ({
    type: "browser_action",
    agentId: "main",
    cid,
    epoch: 1,
    tool: "browser_navigate",
    ok: true,
    resultBytes: 10,
    durationMs: 5,
    ts: 1,
  }) as RunEvent;

describe("the browser action cue", () => {
  it("moves once per browser_action and ignores everything else", () => {
    const before = browserCueCount();
    browserCuePushLive([{ type: "run_start", agentId: "main", ts: 1 } as unknown as RunEvent]);
    expect(browserCueCount()).toBe(before);
    browserCuePushLive([action("c1"), action("c2")]);
    expect(browserCueCount()).toBe(before + 2);
  });

  it("is fed from the app's one event funnel, like the other live stores", () => {
    const app = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toContain("browserCuePushLive(batch)");
  });
});

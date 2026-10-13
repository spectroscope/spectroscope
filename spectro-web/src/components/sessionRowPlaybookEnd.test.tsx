// Card 578: the row of a session whose playbook run ended reads idle at once.
//
// The live check of 0.15.3 (D4) read "itemsapp · working" on the row for over
// a minute after the run's end line, while the footer read ready; a reload said
// idle. The word comes from the server's live set (card 503), and the server
// now publishes idle in the same snapshot that says the run stopped
// (RunStatusLineTest). This file pins the web half: the batch that carries
// the end line and that snapshot redraws the row, with no reload and no poll.
//
// Rendered with renderToStaticMarkup like sessionRowDensity.test.tsx: the live
// line rides the live store, which a server render reads.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Sidebar";
import {
  setDensity,
  __resetForTests as resetDensity,
  __setTestHooks as densityHooks,
} from "../state/density";
import { liveSessionsPushLive, __resetForTests as resetLiveSessions } from "../state/liveSessions";
import type { HeldRow } from "../state/sessionRows";
import type { RunEvent } from "../events";

const written = new Map<string, string>();
densityHooks({
  get: (k) => written.get(k) ?? null,
  set: (k, v) => void written.set(k, v),
});
resetDensity();

const ID = "s-pb";

/** The rail as the page draws it, holding the one session. */
function rail(running: boolean): string {
  const held: HeldRow[] = [{ id: ID, firstPrompt: "Ready", startedAt: 1_000, running, attention: null }];
  return renderToStaticMarkup(
    <Sidebar
      activeId={ID}
      refreshToken={0}
      onSelectSession={() => {}}
      onNewChat={() => {}}
      onSettings={() => {}}
      held={held}
      onImport={() => {}}
      onScenarios={() => {}}
      onStarters={() => {}}
      skillsOpen={false}
      onSkills={() => {}}
      onSelectScenario={() => {}}
      stateGraphSource={null}
      onStateGraphScenario={() => {}}
      activeFleet={null}
      onSelectFleet={() => {}}
      onSpawnNode={() => {}}
      nav="sessions"
      onNav={() => {}}
    />,
  );
}

/** The live set for the session, as the server's `live_sessions` frame carries it. */
function liveFrame(running: boolean, statusLine: string): RunEvent {
  return {
    type: "live_sessions",
    sessions: [{ id: ID, running, since: 1, folder: "/Users/x/itemsapp", statusLine }],
  } as unknown as RunEvent;
}

/** The chat line that closes a playbook run. */
const END_LINE = {
  type: "playbook_progress",
  agentId: "playbook",
  runId: "pr1",
  phase: "end",
  stopReason: "done",
  result: "done",
  ts: 2_000,
} as RunEvent;

afterEach(() => {
  resetLiveSessions();
});

describe("a session row when its playbook run ends (card 578)", () => {
  it("reads working while a step runs and idle in the batch that ends the run", () => {
    setDensity("normal");
    liveSessionsPushLive([liveFrame(true, "working")]);
    const during = rail(true);
    expect(during).toContain("itemsapp · working");
    expect(during, "premise: the running row's dot pulses").toContain('class="dot accent pulse"');

    liveSessionsPushLive([END_LINE, liveFrame(false, "idle")]);
    const after = rail(false);

    expect(after).toContain('<span class="session-live-line">itemsapp · idle</span>');
    expect(after).not.toContain("itemsapp · working");
    expect(after, "the dot stops pulsing with it").not.toContain("pulse");
  });
});

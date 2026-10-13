// Live check 0.15.3 D6 (card 557): against a host that never answers, the
// server asks the backend for its window before run_start, about four seconds.
// The chat drew neither the message nor Stop in that gap. Rendered on React's
// server renderer (this suite has no DOM), so the markup is the chat's paint
// for a record whose message left and whose run has not started.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialState, reduceAll } from "../state/reducer";
import type { UiState } from "../state/reducer";
import { blankBlockComments } from "../testkit/source";
import { Chat } from "./Chat";

const SENT = "Stop me in the gap.";

function markup(state: UiState, liveView: boolean, starting: string | null): string {
  return renderToStaticMarkup(
    <Chat
      state={state}
      liveView={liveView}
      starting={starting}
      onSend={() => {}}
      onReturnToLive={() => {}}
      onAbort={() => {}}
      sendClient={() => true}
    />,
  );
}

const seat = (html: string): string | undefined =>
  /class="composer-seat (composer-seat--(?:stop|send))"/.exec(html)?.[1];

const before = reduceAll(initialState, [
  { type: "run_start", runId: "r0", agentId: "main", prompt: "earlier", ts: 1 },
  { type: "text_delta", agentId: "main", text: "done", ts: 2 },
  { type: "run_end", runId: "r0", stopReason: "end_turn", ts: 3 },
]);

describe("the chat between a sent message and its run_start", () => {
  it("shows the message and offers Stop in a new chat", () => {
    const html = markup(initialState, true, SENT);
    expect(seat(html)).toBe("composer-seat--stop");
    expect(html).toContain(`<div class="user-text">${SENT}</div>`);
    expect(html).not.toContain('class="empty"');
  });

  it("shows the message after the earlier turns and offers Stop in a chat with history", () => {
    const html = markup(before, true, SENT);
    expect(seat(html)).toBe("composer-seat--stop");
    expect(html.indexOf(SENT)).toBeGreaterThan(html.indexOf("earlier"));
  });

  it("is the plain idle chat when nothing waits for its run", () => {
    const html = markup(before, true, null);
    expect(seat(html)).toBe("composer-seat--send");
    expect(html).not.toContain("user-turn--start-pending");
  });

  it("draws nothing of it in an archive", () => {
    const html = markup(before, false, SENT);
    expect(html).not.toContain(SENT);
    expect(html).not.toContain("composer-seat--stop");
  });
});

describe("App hands the gap to the chat", () => {
  const app = blankBlockComments(
    readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8"),
  ).replace(/^\s*\/\/.*$/gm, "");

  it("passes the record's sent message as the chat's start", () => {
    expect(app).toMatch(/starting:\s*slot\.starting,/);
  });

  it("does not promise to steer a run that has not started", () => {
    expect(app).toMatch(
      /steers:\s*steeringView\.understood && queue\.length === 0 && slot\.starting === null,/,
    );
  });
});

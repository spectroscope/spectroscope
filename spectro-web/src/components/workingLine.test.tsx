// Card 244: the working line — the transcript's sign of life in the gap no
// other indicator covers. The caret and the thinking dot both hang off an
// OPEN assistant turn; between run_start and the first delta, and while a
// tool runs, the last turn is a user or tool turn and the transcript shows
// nothing moving at all. The predicate below is pinned against real event
// folds; the markup against a static render; and the mount in Chat.tsx
// against the source, because a pure fold nobody consults can ship dead
// (the sessionRowDensity lesson).

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkingLine, showWorkingLine, workingTimer } from "./WorkingLine";
import { initialState, normalizeReplay, reduceAll } from "../state/reducer";
import type { RunEvent } from "../events";
import { read, stripComments } from "../testkit/source";
import { setLang } from "../state/lang";

const rootStart: RunEvent = {
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "go",
  provider: "anthropic",
  ts: 1000,
};

const fold = (events: RunEvent[]) => reduceAll(initialState, events);

describe("showWorkingLine — when the transcript needs a sign of life", () => {
  it("shows nothing while idle", () => {
    expect(showWorkingLine(initialState, true)).toBe(false);
  });

  it("shows in the gap after run_start, before any assistant turn", () => {
    expect(showWorkingLine(fold([rootStart]), true)).toBe(true);
  });

  it("yields to the thinking dot once reasoning streams", () => {
    const s = fold([rootStart, { type: "thinking_delta", agentId: "main", text: "hm", ts: 1200 }]);
    expect(showWorkingLine(s, true)).toBe(false);
  });

  it("yields to the caret once answer text streams", () => {
    const s = fold([rootStart, { type: "text_delta", agentId: "main", text: "The", ts: 1300 }]);
    expect(showWorkingLine(s, true)).toBe(false);
  });

  it("returns while a tool runs — the last turn is the tool, nothing pulses", () => {
    const s = fold([
      rootStart,
      { type: "text_delta", agentId: "main", text: "Let me look. ", ts: 1300 },
      { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: {}, ts: 1400 },
    ]);
    expect(showWorkingLine(s, true)).toBe(true);
  });

  it("stays away while a permission question is open — that wait is the OWNER's", () => {
    const s = fold([
      rootStart,
      { type: "text_delta", agentId: "main", text: "I need to run this. ", ts: 1300 },
      { type: "tool_call", agentId: "main", callId: "c1", name: "bash", input: {}, ts: 1400 },
      { type: "permission_request", agentId: "main", callId: "c1", name: "bash", input: {}, ts: 1500 },
    ]);
    expect(showWorkingLine(s, true)).toBe(false);
  });

  it("leaves the moment the run ends", () => {
    const s = fold([rootStart, { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2000 }]);
    expect(showWorkingLine(s, false)).toBe(false);
    expect(showWorkingLine(s, true)).toBe(false);
  });

  it("never shows on a replayed archive", () => {
    expect(showWorkingLine(normalizeReplay(fold([rootStart])), true)).toBe(false);
    expect(showWorkingLine(fold([rootStart]), false)).toBe(false);
  });
});

describe("workingTimer — elapsed since the run started", () => {
  it("counts up in the recording indicator's voice", () => {
    expect(workingTimer(8000, 1000)).toBe("0:07");
    expect(workingTimer(97000, 1000)).toBe("1:36");
  });

  it("refuses without a start stamp", () => {
    expect(workingTimer(8000, null)).toBeNull();
  });

  it("clamps clock skew to zero instead of counting backwards", () => {
    expect(workingTimer(1000, 5000)).toBe("0:00");
  });
});

describe("WorkingLine — the rendered line", () => {
  afterEach(() => {
    setLang("en");
    vi.useRealTimers();
  });

  it("announces itself politely and pulses the house dot", () => {
    const html = renderToStaticMarkup(<WorkingLine startTs={null} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("working-line");
    expect(html).toContain("thinking-dot");
    expect(html).toContain("working …");
  });

  it("speaks German when the chrome does", () => {
    setLang("de");
    const html = renderToStaticMarkup(<WorkingLine startTs={null} />);
    expect(html).toContain("arbeitet …");
  });

  it("carries the elapsed timer when the run's start is known", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8000));
    const html = renderToStaticMarkup(<WorkingLine startTs={1000} />);
    expect(html).toContain("0:07");
  });
});

describe("the mount in Chat.tsx — the fold is consulted, not just exported", () => {
  const chat = stripComments(read("./Chat.tsx", import.meta.url));

  it("Chat gates the line on the predicate and hands it the run's start", () => {
    expect(chat).toContain("showWorkingLine(state, liveView)");
    expect(chat).toContain("<WorkingLine startTs={state.runStartTs}");
  });

  it("the line sits at the live edge of the history, after the turns", () => {
    expect(chat.indexOf("<WorkingLine")).toBeGreaterThan(chat.indexOf("blocks.map"));
  });
});

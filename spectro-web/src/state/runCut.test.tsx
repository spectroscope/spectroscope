// Card 586, final fix round (review I4): a run whose session history ends
// without its run_end is cut when the history is loaded, as a stored view or
// as the history a continued session starts from. The operator quit the app
// or the server died during the run: it will not end any more. A cut run
// joins no chat text and no files of the session's later turns, its head
// shows no running clock, and the wide view stops asking for its graph. A
// run that starts in the live session is not cut.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { RunHead } from "../components/RunPanel";
import { initialState, normalizeReplay, reduce, reduceAll } from "./reducer";
import { seedResumedLive } from "./resume";
import { cutOpenRuns, foldRun, isUnfinished, runsTick, type RunTrack } from "./runView";
import { runGraphAsk } from "./useRunGraph";

const R = "abcdefabcdef";
const line = (fields: Record<string, unknown>): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId: R,
    runKind: "playbook",
    ts: 1,
    ...fields,
  }) as unknown as RunEvent;
const opened = line({ phase: "run_start", name: "spectro", nodes: [{ id: "a", name: "A", kind: "step" }] });
const chatStep = line({
  phase: "step_start",
  node: "a",
  name: "A",
  kind: "step",
  entry: 1,
  performer: "chat",
  ts: 2,
});
const ended = line({ phase: "run_end", stopReason: "done", ts: 9 });
/** The session's own chat after the run: an answer and a written file. */
const laterChat: RunEvent[] = [
  { type: "text_delta", agentId: "main", text: "a new answer", ts: 20 } as RunEvent,
  {
    type: "tool_call",
    agentId: "main",
    callId: "c9",
    name: "write_file",
    input: { path: "notes.md", content: "x" },
    ts: 21,
  } as RunEvent,
  {
    type: "tool_result",
    agentId: "main",
    callId: "c9",
    output: "Wrote",
    isError: false,
    fileChange: "created",
    ts: 22,
  } as RunEvent,
];

const interrupted = (): RunTrack[] => [opened, chatStep].reduce(foldRun, [] as RunTrack[]);

describe("cutOpenRuns (card 586, review I4)", () => {
  it("cuts a run without run_end and leaves an ended one alone", () => {
    const open = interrupted();
    const done = [opened, chatStep, ended].reduce(foldRun, [] as RunTrack[]);
    expect(cutOpenRuns(open)[0].cut).toBe(true);
    expect(cutOpenRuns(done), "nothing open: the same array").toBe(done);
    expect(cutOpenRuns([]), "no run: the same array").toEqual([]);
  });

  it("a cut run takes no chat text and no file of later turns", () => {
    const cut = cutOpenRuns(interrupted());
    const after = laterChat.reduce(foldRun, cut);
    expect(after, "the same array: nothing joined").toBe(cut);
    const uncut = laterChat.reduce(foldRun, interrupted());
    expect(uncut[0].entries[0].liveLine, "premise: an open run joins them").toBe("a new answer");
    expect(uncut[0].entries[0].files.map((f) => f.path)).toEqual(["notes.md"]);
  });

  it("a cut run is unfinished also in a live session, and nothing ticks for it", () => {
    const cut = cutOpenRuns(interrupted());
    expect(isUnfinished(cut[0], true)).toBe(true);
    expect(runsTick(cut, true)).toBe(false);
    expect(runsTick(interrupted(), true), "premise: an open live run ticks").toBe(true);
    expect(runsTick(interrupted(), false)).toBe(false);
  });

  it("the head of a cut run in a live session shows no running clock", () => {
    const cut = cutOpenRuns(interrupted());
    const html = renderToStaticMarkup(
      <RunHead
        runs={cut}
        index={0}
        live
        now={1_000_000}
        wide={false}
        onPick={() => {}}
        onToggleWide={() => {}}
      />,
    );
    expect(html).toContain("no end recorded");
    expect(html).not.toContain("running");
    const live = renderToStaticMarkup(
      <RunHead
        runs={interrupted()}
        index={0}
        live
        now={1_000_000}
        wide={false}
        onPick={() => {}}
        onToggleWide={() => {}}
      />,
    );
    expect(live, "premise: an open live run shows its clock").toContain("running");
  });

  it("the wide view asks a cut run's graph once and does not poll", () => {
    const cut = cutOpenRuns(interrupted());
    expect(runGraphAsk("s-1", cut[0], true)?.poll).toBe(false);
    expect(runGraphAsk("s-1", interrupted()[0], true)?.poll, "premise: an open live run polls").toBe(true);
  });
});

describe("a loaded history cuts its open runs (card 586, review I4)", () => {
  it("a stored view (normalizeReplay) cuts the run", () => {
    const stored = normalizeReplay(reduceAll(initialState, [opened, chatStep]));
    expect(stored.runs[0].cut).toBe(true);
  });

  it("a continued session (seedResumedLive) cuts the run, and its later chat stays out of it", () => {
    const seeded = seedResumedLive(reduceAll(initialState, [opened, chatStep]));
    expect(seeded.runs[0].cut).toBe(true);
    const continued = laterChat.reduce(reduce, seeded);
    expect(continued.runs[0].entries[0].liveLine).toBeNull();
    expect(continued.runs[0].entries[0].files).toEqual([]);
  });

  it("a history without an open run comes back as it was", () => {
    const done = reduceAll(initialState, [opened, chatStep, ended]);
    expect(seedResumedLive(done).runs).toBe(done.runs);
    expect(normalizeReplay(done).runs).toBe(done.runs);
  });

  it("a run that starts in the live session is not cut and joins its chat", () => {
    const live = [opened, chatStep, ...laterChat].reduce(reduce, initialState);
    expect(live.runs[0].cut).toBeUndefined();
    expect(live.runs[0].entries[0].liveLine).toBe("a new answer");
  });

  it("a run that starts after a continued session's history is not cut", () => {
    const seeded = seedResumedLive(reduceAll(initialState, [opened, chatStep]));
    const R2 = "bbbbbbbbbbbb";
    const next = [
      { ...(opened as object), runId: R2, ts: 30 },
      { ...(chatStep as object), runId: R2, ts: 31 },
      { type: "text_delta", agentId: "main", text: "second run", ts: 32 },
    ].reduce((s, e) => reduce(s, e as RunEvent), seeded);
    expect(next.runs.map((r) => [r.runId, r.cut === true])).toEqual([
      [R, true],
      [R2, false],
    ]);
    expect(next.runs[1].entries[0].liveLine).toBe("second run");
  });
});

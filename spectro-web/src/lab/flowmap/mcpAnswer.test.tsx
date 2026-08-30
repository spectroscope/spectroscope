// CARD 328 — the MCP server answers. RED FIRST: nothing below is implemented.
//
// What these cases drive, and why they are shaped this way:
//
//   · The answer is ALREADY on the wire and is deliberately thrown away.
//     `tool_result { agentId, callId, output, isError, durationMs, ts }`
//     (events.ts:36-47) reaches `deriveDetail`, whose `tool_result` case sets
//     `d.tool[agentId] = undefined` (sceneToFlow.ts:216-217). So no recording
//     has to be added — a fold change makes it visible.
//
//   · Every case here drives BEHAVIOUR: events in, `deriveDetail`/`sceneToFlow`
//     in the middle, rendered markup out. Nothing greps a source file.
//
//   · The two markup hooks these tests demand are a CONTRACT, not decoration,
//     because the criterion is "both cards are visibly the same call" and a
//     test that pinned the visible FORM of a call id would break the first time
//     the card shortened it:
//       data-call="<callId>"   on the MCP-Client card and on the MCP-Server card
//       data-answer="waiting" | "answered" | "empty" | "none"   on the server card
//     `waiting` and `empty` are two different facts and must never render alike.
//
//   · Fixtures are built from the SHAPES the survey measured, never copied from
//     the store. The one real MCP pair on this machine is
//     `mcp__notes__search_notes` with an 85-byte answer at 23 ms; the sizes
//     below (209 B median, 246 112 B max) come from 3 000 `mcp__` results
//     sampled out of ~/.claude/projects with random.seed(328). The empty answer
//     is SYNTHETIC ON PURPOSE: zero of 3 503 measured results was empty, so the
//     contract is real and the corpus has never exercised it.
//
// Rendered with react-dom/server like every other card suite here — this gate
// has no DOM — with the canvas package's Handle stubbed out.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, EXPANDED_CARD, sceneToFlow, type Detail } from "./sceneToFlow";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { ExtNode, OsNode } from "./nodes";

const Ext = ExtNode as unknown as (p: { data: unknown }) => ReactElement;
const Os = OsNode as unknown as (p: { data: unknown }) => ReactElement;

const T = 1784292223291;

// ---------------------------------------------------------------------------
// The record this card has to add, reached through a cast.
//
// The cast is deliberate: it keeps `tsc -b` green while the field does not
// exist, so every case below goes red on its ASSERTION and not on a compile
// error. An import error is a typo; these are tests.
// ---------------------------------------------------------------------------
interface McpAnswer {
  callId: string;
  agentId: string;
  name: string;
  output: string;
  isError: boolean;
  durationMs: number;
}
const answersOf = (d: Detail): Record<string, McpAnswer | undefined> =>
  (d as unknown as { answers?: Record<string, McpAnswer | undefined> }).answers ?? {};

// ---------------------------------------------------------------------------
// Fixtures — the shapes, never the store's content.
// ---------------------------------------------------------------------------
const CALL_A = "toolu_01UHwCPaAYawCQPw9aaApGAo"; // the real shape: a 24-char tool_use id
const CALL_B = "toolu_01ZZmqRf7Kd2Ns4Vb8XcPwQr";
const MCP_TOOL = "mcp__notes__search_notes";

/** 209 characters — the measured p50 of an mcp__ answer. */
const MEDIAN_ANSWER = "note ".repeat(50).slice(0, 209);
/** 246 112 characters — the measured max, which in the corpus is a base64 screenshot. */
const BIG_ANSWER = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph".repeat(7000).slice(0, 246112);
/** Measured max over 191 error answers: 911 bytes. An error is always small. */
const ERROR_ANSWER = 'ERROR: notes server refused "gate": no index has been built yet.';

const runStart = (runId: string, ts = T): RunEvent =>
  ({
    type: "run_start",
    runId,
    agentId: "main",
    prompt: "search the notes",
    provider: "anthropic",
    ts,
  }) as RunEvent;

const mcpCall = (callId: string, query: string, ts = T): RunEvent =>
  ({ type: "tool_call", agentId: "main", callId, name: MCP_TOOL, input: { query }, ts }) as RunEvent;

const mcpResult = (callId: string, output: string, isError = false, durationMs = 23, ts = T + 23): RunEvent =>
  ({ type: "tool_result", agentId: "main", callId, output, isError, durationMs, ts }) as RunEvent;

function fold(events: RunEvent[]) {
  const scene = events.reduce(advanceScene, initialScene());
  const detail = deriveDetail(events);
  return { detail, flow: sceneToFlow(scene, detail, { provider: "anthropic", model: "claude-opus-5" }) };
}

const dataOf = (flow: { nodes: { id: string; data: unknown }[] }, id: string): Record<string, unknown> =>
  (flow.nodes.find((n) => n.id === id)?.data ?? {}) as Record<string, unknown>;

const serverMarkup = (events: RunEvent[]) =>
  renderToStaticMarkup(<Ext data={dataOf(fold(events).flow, "mcpserver")} />);
const clientMarkup = (events: RunEvent[]) =>
  renderToStaticMarkup(<Os data={dataOf(fold(events).flow, "os-mcp")} />);

/** The call a card says it is showing. Format-free on purpose: the card may
 *  print the id in any form it likes, but it has to SAY which call it means. */
const callMark = (markup: string): string | null => /data-call="([^"]*)"/.exec(markup)?.[1] ?? null;
/** Which of the four readings the server card is in. */
const answerMark = (markup: string): string | null => /data-answer="([^"]*)"/.exec(markup)?.[1] ?? null;

// ---------------------------------------------------------------------------
// 1. The answer survives the fold — each field on its own.
//
// Four cases, because "two fields falling on one message is one case, not
// four". Before the record exists all four fail together; the point of the
// separation is the bite AFTER it exists — delete one field, exactly one of
// these four goes red.
// ---------------------------------------------------------------------------
describe("the fold keeps the answer (card 328, criterion 1)", () => {
  const answered = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, MEDIAN_ANSWER)];

  it("carries the output past the tool_result case", () => {
    expect(answersOf(deriveDetail(answered))[CALL_A]?.output).toBe(MEDIAN_ANSWER);
  });

  it("carries isError", () => {
    const errored = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, ERROR_ANSWER, true)];
    expect(answersOf(deriveDetail(errored))[CALL_A]?.isError).toBe(true);
  });

  it("carries durationMs", () => {
    // 23 ms — the one real MCP pair in the store, and the measured p50.
    expect(answersOf(deriveDetail(answered))[CALL_A]?.durationMs).toBe(23);
  });

  it("carries the tool's name, which only the CALL ever said", () => {
    // tool_result has no `name` field. Carrying it forward from the tool_call
    // is the whole reason this is a join and not a lookup.
    expect(answersOf(deriveDetail(answered))[CALL_A]?.name).toBe(MCP_TOOL);
  });
});

// ---------------------------------------------------------------------------
// 2. One question, one answer — proved on the render.
// ---------------------------------------------------------------------------
describe("client and server show the SAME call (card 328, criterion 2)", () => {
  it("both cards name the call that was asked", () => {
    const events = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, MEDIAN_ANSWER)];
    expect(callMark(clientMarkup(events))).toBe(CALL_A);
    expect(callMark(serverMarkup(events))).toBe(CALL_A);
  });

  it("with two calls open, the server answers the one the client is showing", () => {
    // Measured over 783 session files by deepest same-agent open-call count:
    // 10 files peak at 2, 8 at 3, 1 at 4, 1 at 12 and 1 at 90. `Detail.tool` is
    // Record<agentId, …> — one slot, last write wins — so this is exactly where
    // a per-agent key mis-pairs and nothing goes red.
    const events = [
      runStart("r1"),
      mcpCall(CALL_A, "gate"),
      mcpCall(CALL_B, "runbook"),
      mcpResult(CALL_B, MEDIAN_ANSWER),
    ];
    const client = clientMarkup(events);
    const server = serverMarkup(events);
    expect(callMark(client)).toBe(CALL_B);
    expect(callMark(server)).toBe(CALL_B);
    expect(callMark(server)).not.toBe(CALL_A);
  });
});

// ---------------------------------------------------------------------------
// 3. The join is scoped to one run.
// ---------------------------------------------------------------------------
describe("the join cannot pair across runs (card 328, criterion 3)", () => {
  it("a callId reused by a later run does not inherit the earlier answer", () => {
    // Measured: callId is NOT globally unique — "c1" appears in 31 distinct
    // session files, 472 distinct ids over 506 calls. A pooled view that keyed
    // on the id alone would mis-pair silently, with nothing red.
    const events = [
      runStart("r1"),
      mcpCall("c1", "gate"),
      mcpResult("c1", "THE FIRST RUN'S ANSWER"),
      runStart("r2", T + 1000),
      mcpCall("c1", "runbook", T + 1001),
    ];
    const server = serverMarkup(events);
    expect(server).not.toContain("THE FIRST RUN'S ANSWER");
    expect(answerMark(server)).toBe("waiting");
  });

  it("a second run that asks nothing does not inherit the first run's answer", () => {
    // ADDED DURING THE BUILD, and the house rule is why. The case above is
    // green in BOTH directions against the run scope: run two re-uses the same
    // callId, so the tool_call case overwrites the record on its own and the
    // clear never has to fire — deleting the clear left the whole file green,
    // measured. This is the shape only the clear can carry: run two asks
    // nothing at all, so nothing overwrites anything, and a table that outlived
    // its run would hang run one's answer on run two's map.
    const events = [
      runStart("r1"),
      mcpCall(CALL_A, "gate"),
      mcpResult(CALL_A, MEDIAN_ANSWER),
      runStart("r2", T + 1000),
    ];
    const server = serverMarkup(events);
    expect(answerMark(server)).toBe("none");
    expect(server).not.toContain(MEDIAN_ANSWER.slice(0, 40));
  });
});

// ---------------------------------------------------------------------------
// 4. Waiting / answered-with-content / answered-with-nothing are three
//    renderings, bitten one at a time.
// ---------------------------------------------------------------------------
describe("the three readings (card 328, criterion 4)", () => {
  const waiting = [runStart("r1"), mcpCall(CALL_A, "gate")];
  const withContent = [...waiting, mcpResult(CALL_A, MEDIAN_ANSWER)];
  const withNothing = [...waiting, mcpResult(CALL_A, "")];

  it("a call with no result yet reads as waiting", () => {
    expect(answerMark(serverMarkup(waiting))).toBe("waiting");
  });

  it("an answer with content reads as answered, and the content is on the card", () => {
    const m = serverMarkup(withContent);
    expect(answerMark(m)).toBe("answered");
    expect(m).toContain(MEDIAN_ANSWER.slice(0, 40));
  });

  it("an answer that is the empty string says the answer was empty", () => {
    // SYNTHETIC ON PURPOSE: zero empty answers in 3 503 measured results across
    // both corpora. The contract is real; the corpus has never exercised it.
    expect(answerMark(serverMarkup(withNothing))).toBe("empty");
  });

  it("waiting and answered-with-nothing do not render alike", () => {
    expect(answerMark(serverMarkup(withNothing))).not.toBe(answerMark(serverMarkup(waiting)));
    expect(serverMarkup(withNothing)).not.toBe(serverMarkup(waiting));
  });

  it("a run that never called an MCP server says nothing was asked", () => {
    expect(answerMark(serverMarkup([runStart("r1")]))).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 5. Waiting stays waiting for as long as the call takes.
// ---------------------------------------------------------------------------
describe("waiting does not decay (card 328, criterion 5)", () => {
  it("a call open for sixty minutes still reads as waiting", () => {
    // Measured over 503 call/result pairs: p50 23 ms, p90 1 260, p99 101 480,
    // max 3 598 164 — sixty minutes. Three of 783 sessions end mid-call and
    // never answer at all; that run must read waiting forever.
    const events: RunEvent[] = [
      runStart("r1"),
      mcpCall(CALL_A, "gate"),
      { type: "usage", agentId: "main", inputTokens: 12, outputTokens: 3, ts: T + 3598164 } as RunEvent,
    ];
    const m = serverMarkup(events);
    expect(answerMark(m)).toBe("waiting");
    expect(answerMark(m)).not.toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// 6. An error is its own mark, AND the mark is reachable.
//
// The second case carries the inherited defect in full. Today the red MCP chain
// cannot fire for an ANSWERED error at all, by construction:
//   advanceLoop's tool_result case spreads idleActivity()  (labScene.ts:256)
//   idleActivity() sets activeMcp: null                    (labScene.ts:172)
//   MCP occupancy IS activeMcp !== null                    (stationUsers.ts:47)
//   so mcpUser is undefined and mcpErr = !!mcpUser?.loop.isError is false
//                                                          (sceneToFlow.ts:1585)
// The only reachable red chain is a DENIED permission_decision, and all three
// MCP calls in the store were allowed — so it has never once fired.
// ---------------------------------------------------------------------------
describe("an error answer is marked, and the mark can be seen (card 328, criterion 6)", () => {
  const errored = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, ERROR_ANSWER, true)];

  it("the server card marks the error and still reads as answered", () => {
    const m = serverMarkup(errored);
    expect(answerMark(m)).toBe("answered");
    expect(m).toContain('data-answer-error="true"');
  });

  it("the error message is readable on the card — an error is an answer, not a crash", () => {
    expect(serverMarkup(errored)).toContain("no index has been built yet");
  });

  // GREEN TODAY, vacuously — the server card renders no mark of any kind yet.
  // It is the other-direction guard for the two red cases above: once the mark
  // exists, an implementation that stamps it unconditionally goes red here.
  it("a NON-error answer does not carry the error mark", () => {
    const ok = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, MEDIAN_ANSWER)];
    expect(serverMarkup(ok)).not.toContain('data-answer-error="true"');
  });

  it("the MCP chain out to the server carries the error", () => {
    const { flow } = fold(errored);
    const leg = (id: string) => (flow.edges.find((e) => e.id === id)?.data ?? {}) as { err?: boolean };
    expect(leg("e-osmcp-osnet").err).toBe(true);
    expect(leg("e-netz-mcpserver").err).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. The answer region is bounded — measured on what reaches the card, not on
//    the presence of a max-height.
// ---------------------------------------------------------------------------
describe("a huge answer does not become a huge card (card 328, criterion 7)", () => {
  it("a quarter-megabyte answer is shown, and does not cross onto the card whole", () => {
    // Measured over 3 000 mcp__ results: p50 209 B, p90 27 832, p99 78 277,
    // max 246 112 — a 130x spread between median and p90, and 14.6 % of the
    // answers are an image block rather than text.
    //
    // The first assertion is what keeps the second honest. On its own, "the
    // markup is under 32 KB" is satisfied by a card that renders nothing at
    // all — green in both directions. Demanding that the card ALSO reads as
    // answered makes it red today and keeps it biting afterwards.
    const events = [runStart("r1"), mcpCall(CALL_A, "shot"), mcpResult(CALL_A, BIG_ANSWER)];
    expect(BIG_ANSWER).toHaveLength(246112);
    const m = serverMarkup(events);
    expect(answerMark(m)).toBe("answered");
    expect(m.length).toBeLessThan(32768);
  });

  it("a median-sized answer is carried whole", () => {
    // The other direction: without this, "truncate to nothing" would pass the
    // case above and the card would be bounded by saying nothing.
    const events = [runStart("r1"), mcpCall(CALL_A, "gate"), mcpResult(CALL_A, MEDIAN_ANSWER)];
    expect(answersOf(deriveDetail(events))[CALL_A]?.output).toBe(MEDIAN_ANSWER);
  });
});

// ---------------------------------------------------------------------------
// 8. The seat is measured under a NEW key, and `ext` is not touched.
//
// `envelopeOf` is `n.env ?? EXPANDED_CARD[n.id] ?? EXPANDED_CARD[n.type]`
// (sceneToFlow.ts:395) and BOTH `netz` and `mcpserver` are emitted as type
// "ext" (sceneToFlow.ts:1338-1339), so growing `ext` grows the Net card by the
// same amount. Card 328 takes the `mcpserver` key, card 329 takes `netz`, and
// `ext` itself stays as it is — which is what makes the two a resolvable merge.
// ---------------------------------------------------------------------------
describe("the MCP-Server seat is its own (card 328, criterion 8/9)", () => {
  // The table is typed Record<string, {w,h}>, so a lookup is total and a
  // missing key reads as undefined rather than as a compile error — which is
  // what keeps these red on their assertion.
  const seat = (id: string): { w: number; h: number } | undefined => EXPANDED_CARD[id];

  it("mcpserver has an envelope of its own", () => {
    expect(seat("mcpserver")).toBeDefined();
  });

  // GREEN TODAY: a regression guard, not coverage. `ext` sizes BOTH external
  // cards, so growing it instead of adding a key would silently resize the Net
  // card and turn a resolvable merge with card 329 into a collision.
  it("the shared ext envelope is left exactly as it was", () => {
    expect(seat("ext")).toEqual({ w: 150, h: 110 });
  });

  it("the MCP-Server width stays 150 — widths feed card 319's layout", () => {
    // EXT_W = EXPANDED_CARD.ext.w (:754) -> EXT_ROW_W (:756) -> MCPSERVER_X
    // (:769). Height-only growth under a new key touches none of them.
    expect(seat("mcpserver")?.w).toBe(150);
  });
});

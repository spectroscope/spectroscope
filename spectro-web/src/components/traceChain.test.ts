import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import { detectAndLoad } from "../import/detect";
import { attachSources } from "../state/traceSource";
import { reasoningLead } from "./TraceView";
import ccSplit from "../import/fixtures/cc-split-message.jsonl?raw";
import { causalChain, reasoningPairs, reasoningBlockText, reasoningReach } from "./traceChain";

const E = (
  seq: number,
  type: string,
  agentId: string | undefined,
  payload: Record<string, unknown>,
): TraceEntry => ({
  seq,
  dir: "in",
  ts: 1000 + seq,
  type,
  ...(agentId !== undefined ? { agentId } : {}),
  payload: { type, ...(agentId !== undefined ? { agentId } : {}), ...payload },
});

// prompt -> turn -> thinking -> call -> gate request -> decision -> result,
// plus a subagent spawned from main with its own run and call.
const stream: TraceEntry[] = [
  E(1, "run_start", "main", { runId: "r1", prompt: "clean up /tmp" }),
  E(2, "turn_start", "main", { turn: 1 }),
  E(3, "thinking_delta", "main", { text: "rm needs a gate…" }),
  E(4, "thinking_delta", "main", { text: "asking first." }),
  E(5, "tool_call", "main", { callId: "c1", name: "run_command", input: { cmd: "rm -rf data/tmp" } }),
  E(6, "permission_request", "main", { callId: "c1", name: "run_command" }),
  E(7, "permission_decision", undefined, { callId: "c1", allowed: true }),
  E(8, "tool_result", "main", { callId: "c1", output: "ok", isError: false }),
  E(9, "agent_spawn", "helper", { parentId: "main", task: "verify" }),
  E(10, "run_start", "helper", { runId: "r2", parentId: "main", prompt: "verify" }),
  E(11, "turn_start", "helper", { turn: 1 }),
  E(12, "tool_call", "helper", { callId: "c2", name: "read_file", input: {} }),
  E(13, "text_delta", "main", { text: "done." }),
];

describe("causalChain", () => {
  it("walks a tool_result back to the prompt through gate, call and turn", () => {
    const chain = causalChain(stream, stream[7]); // seq 8, tool_result
    expect(chain.map((e) => e.type)).toEqual([
      "run_start",
      "turn_start",
      "tool_call",
      "permission_request",
      "permission_decision",
      "tool_result",
    ]);
    expect(chain[0].seq).toBe(1); // the root prompt anchors the chain
  });

  it("hops a subagent call over its spawn to the parent run", () => {
    const chain = causalChain(stream, stream[11]); // seq 12, helper tool_call
    expect(chain.map((e) => e.seq)).toEqual([1, 9, 10, 11, 12]);
    expect(chain[1].type).toBe("agent_spawn");
  });

  it("keeps a frame with no known links as a single-element chain", () => {
    const lone = E(99, "usage", "main", { inputTokens: 1, outputTokens: 1 });
    expect(causalChain(stream, lone)).toEqual([lone]);
  });
});

/**
 * Both lens maps key the row that OPENS a block, and this used to be the row
 * that closed it.
 *
 * The owner reported that "a turn_start always has a huge thinking event and
 * the thinking lens ignores it", and the measurement said he was right. On his
 * own transcript the 451 thinking frames form 305 blocks, 146 of them two rows
 * long. In 146 of those 146 the FIRST row sits directly under the turn_start,
 * and in 146 of 146 it holds more text than the second — so the lens drew its
 * panel and its "then:" chip on the short tail while the long thought above it,
 * the one the eye lands on, showed nothing at all. Measured example, seq 13/14:
 * 788 characters silent, 112 characters carrying the whole joined block.
 *
 * The block still reads as one block and the joined text is unchanged. What
 * moved is which row wears it: the one where the block starts, which is the row
 * under the turn_start.
 */
describe("reasoningPairs", () => {
  it("pairs the START of a thinking block with the next same-agent action", () => {
    const pairs = reasoningPairs(stream);
    expect(pairs.get(3)).toBe(5); // block 3-4 opens at 3 -> tool_call seq 5
    expect(pairs.has(4)).toBe(false); // the block wears its pair once, at the top
  });

  it("pairs across other agents' frames, never with them", () => {
    const s = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "tool_call", "helper", { callId: "x", name: "read_file", input: {} }),
      E(3, "text_delta", "main", { text: "answer" }),
    ];
    expect(reasoningPairs(s).get(1)).toBe(3);
  });

  it("looks for the action past the whole block, not past its first row", () => {
    // The action follows the block; anchoring at the top must not make the
    // block's own later rows count as the thing it led to.
    const s = [
      E(1, "thinking_delta", "main", { text: "first " }),
      E(2, "thinking_delta", "main", { text: "second" }),
      E(3, "tool_call", "main", { callId: "c", name: "x", input: {} }),
    ];
    expect(reasoningPairs(s).get(1)).toBe(3);
  });
});

describe("reasoningBlockText", () => {
  it("joins a block's full thinking text onto the seq that OPENS it", () => {
    const blocks = reasoningBlockText(stream);
    expect(blocks.get(3)).toBe("rm needs a gate…asking first.");
    expect(blocks.has(4)).toBe(false); // said once, on the row the block starts on
  });

  it("keeps separate agents' blocks apart", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "a", { text: "A1 " }),
      E(2, "thinking_delta", "a", { text: "A2" }),
      E(3, "thinking_delta", "b", { text: "B1" }),
      E(4, "tool_call", "b", { callId: "c", name: "x", input: {} }),
    ];
    const blocks = reasoningBlockText(s);
    expect(blocks.get(1)).toBe("A1 A2");
    expect(blocks.get(3)).toBe("B1");
  });

  it("puts the long thought's own row in charge of showing it", () => {
    // The owner's shape, in miniature: a long first row and a short tail.
    const s: TraceEntry[] = [
      E(1, "turn_start", "main", { turn: 7 }),
      E(2, "thinking_delta", "main", { text: "x".repeat(788) }),
      E(3, "thinking_delta", "main", { text: "y".repeat(112) }),
      E(4, "tool_call", "main", { callId: "c", name: "Bash", input: {} }),
    ];
    const blocks = reasoningBlockText(s);
    expect(blocks.get(2)).toHaveLength(900);
    expect(blocks.has(3)).toBe(false);
    expect(reasoningPairs(s).get(2)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// THE ROWS A READER LANDS ON.
//
// Owner, after the anchor moved onto the block's first row: the lens has to
// take the turn_start and the tool rows into account too, "there is a whole lot
// in there", and not showing it is not good.
//
// Measured over the 5,119 transcripts in ~/.claude/projects, counting what the
// importer EMITS (not what the files hold — 68.5% of assistant records are
// sidechain and most import as orphans):
//
//   - the lens speaks on 16,579 thinking blocks, 18,770,600 characters;
//   - the first row of ALL 16,579 sits directly under a turn_start, and 16,572
//     of them (99.96%, 18,763,578 characters) come from THE SAME LINE of the
//     file as that turn_start. One assistant record writes the turn and the
//     thought; the importer fans it out into two rows and the reading landed on
//     the lower one. So the turn_start row was silent about text that is on its
//     own line.
//   - 41,346 tool_call rows exist and not one of them says anything under the
//     lens. 19,589 of them ran while a block was in charge; the "then:" chip
//     names only the FIRST action after a block, it is drawn on the block's row,
//     and it reaches 7,061 of them. Standing on a call, there was no way back to
//     the thought that produced it.
//
// So: a block's reading rides on the row that opens its LINE (the same rule
// noteAnchors uses for the source chips), and every action a block was in
// charge of can point back at it. 29,043 action rows gain that pointer.
// ---------------------------------------------------------------------------

/** An entry that knows which line of an imported file produced it. */
const S = (
  seq: number,
  type: string,
  agentId: string | undefined,
  sourceLine: number,
  payload: Record<string, unknown> = {},
): TraceEntry => ({ ...E(seq, type, agentId, payload), sourceLine });

describe("the lens on an imported line", () => {
  // One assistant record: turn_start, its thinking, then its tool_use on the
  // NEXT line of the file.
  const imported: TraceEntry[] = [
    S(1, "run_start", "main", 0, { runId: "r", prompt: "go" }),
    S(2, "turn_start", "main", 1, { turn: 1 }),
    S(3, "thinking_delta", "main", 1, { text: "the long thought " }),
    S(4, "thinking_delta", "main", 1, { text: "and its tail" }),
    S(5, "tool_call", "main", 2, { callId: "c1", name: "Bash", input: {} }),
    S(6, "tool_result", "main", 3, { callId: "c1", output: "ok" }),
    S(7, "tool_call", "main", 4, { callId: "c2", name: "Read", input: {} }),
  ];

  it("wears the block's reading on the turn_start it shares a line with", () => {
    const blocks = reasoningBlockText(imported);
    expect(blocks.get(2)).toBe("the long thought and its tail");
    expect(blocks.has(3)).toBe(false); // said once, on the row that opens the line
  });

  it("moves the said-vs-did chip onto that same row", () => {
    expect(reasoningPairs(imported).get(2)).toBe(5);
    expect(reasoningPairs(imported).has(3)).toBe(false);
  });

  it("leaves the reading on the thinking row when the turn_start is another line", () => {
    // 7 of 16,579 blocks in the corpus: the thinking arrived in a later record
    // of the same response, so the turn_start is a different line and claiming
    // it would put the thought on a line that does not carry it.
    const s: TraceEntry[] = [
      S(1, "turn_start", "main", 1, { turn: 1 }),
      S(2, "text_delta", "main", 1, { text: "one moment" }),
      S(3, "thinking_delta", "main", 2, { text: "second thoughts" }),
      S(4, "tool_call", "main", 3, { callId: "c", name: "Bash", input: {} }),
    ];
    expect(reasoningBlockText(s).get(3)).toBe("second thoughts");
    expect(reasoningBlockText(s).has(1)).toBe(false);
  });

  it("keeps a second block on the same line on its own row", () => {
    // A record holding thinking, then text, then thinking again produces two
    // blocks off ONE line. Only the first can wear the line's anchor; giving it
    // to both would take the earlier thought off the screen.
    const s: TraceEntry[] = [
      S(1, "turn_start", "main", 1, { turn: 1 }),
      S(2, "thinking_delta", "main", 1, { text: "first thought" }),
      S(3, "text_delta", "main", 1, { text: "hold on" }),
      S(4, "thinking_delta", "main", 1, { text: "second thought" }),
      S(5, "tool_call", "main", 2, { callId: "c", name: "Bash", input: {} }),
    ];
    const blocks = reasoningBlockText(s);
    expect(blocks.get(1)).toBe("first thought");
    expect(blocks.get(4)).toBe("second thought");
    expect(blocks.size).toBe(2);
  });

  it("leaves a session produced here exactly where it was", () => {
    // No source lines: the turn_start is its own wire frame from its own moment
    // and never carried the thought. The rule cannot fire and must not.
    const blocks = reasoningBlockText(stream);
    expect(blocks.get(3)).toBe("rm needs a gate…asking first.");
    expect(blocks.has(2)).toBe(false);
  });
});

describe("reasoningReach", () => {
  const imported: TraceEntry[] = [
    S(1, "turn_start", "main", 1, { turn: 1 }),
    S(2, "thinking_delta", "main", 1, { text: "read it, then patch it" }),
    S(3, "tool_call", "main", 2, { callId: "c1", name: "Read", input: {} }),
    S(4, "tool_result", "main", 3, { callId: "c1", output: "ok" }),
    S(5, "tool_call", "main", 4, { callId: "c2", name: "Edit", input: {} }),
  ];

  it("points every action the block was in charge of back at it", () => {
    const reach = reasoningReach(imported);
    expect(reach.get(3)).toBe(1); // the anchored block, on the turn_start
    expect(reach.get(5)).toBe(1); // the second call too — "then:" names only the first
  });

  it("says nothing on a row that is not an action", () => {
    const reach = reasoningReach(imported);
    expect(reach.has(4)).toBe(false); // tool_result: the card's job, not the lens's
    expect(reach.has(1)).toBe(false); // the block's own row never points at itself
    expect(reach.has(2)).toBe(false);
  });

  it("stops at the next block: a call answers to the thought that preceded it", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "first" }),
      E(2, "tool_call", "main", { callId: "a", name: "x", input: {} }),
      E(3, "thinking_delta", "main", { text: "second" }),
      E(4, "tool_call", "main", { callId: "b", name: "y", input: {} }),
    ];
    const reach = reasoningReach(s);
    expect(reach.get(2)).toBe(1);
    expect(reach.get(4)).toBe(3);
  });

  it("stops at the next turn", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "tool_call", "main", { callId: "a", name: "x", input: {} }),
      E(3, "turn_start", "main", { turn: 2 }),
      E(4, "tool_call", "main", { callId: "b", name: "y", input: {} }),
    ];
    const reach = reasoningReach(s);
    expect(reach.get(2)).toBe(1);
    expect(reach.has(4)).toBe(false); // a turn that did not think says nothing
  });

  it("never lends one agent's reasoning to another", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "tool_call", "helper", { callId: "a", name: "x", input: {} }),
      E(3, "tool_call", "main", { callId: "b", name: "y", input: {} }),
    ];
    const reach = reasoningReach(s);
    expect(reach.has(2)).toBe(false);
    expect(reach.get(3)).toBe(1);
  });

  it("produces nothing at all for a stream that never thought", () => {
    const s: TraceEntry[] = [
      E(1, "turn_start", "main", { turn: 1 }),
      E(2, "tool_call", "main", { callId: "a", name: "x", input: {} }),
      E(3, "text_delta", "main", { text: "done" }),
    ];
    expect(reasoningReach(s).size).toBe(0);
  });

  // A session produced HERE streams the answer token by token: one text_delta
  // is one chunk, not one thing the model did. Measured on the 175 sessions in
  // ~/.spectro/sessions before this rule: 75 blocks produced 3,213 back-chips,
  // 3,150 of them on a text_delta, and on 20260725-175159-422e84fb one answer
  // wore 720 identical buttons. The pointer has to stay a pointer.
  it("draws one chip on a streamed answer, on the chunk that opens it", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "greet back" }),
      E(2, "text_delta", "main", { text: "Hal" }),
      E(3, "text_delta", "main", { text: "lo" }),
      E(4, "text_delta", "main", { text: "!" }),
    ];
    const reach = reasoningReach(s);
    expect(reach.get(2)).toBe(1);
    expect(reach.has(3)).toBe(false);
    expect(reach.has(4)).toBe(false);
    expect(reach.size).toBe(1);
  });

  it("gives a second answer its own chip when something ran in between", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "look, then say" }),
      E(2, "text_delta", "main", { text: "checking" }),
      E(3, "text_delta", "main", { text: " now" }),
      E(4, "tool_call", "main", { callId: "a", name: "read_file", input: {} }),
      E(5, "tool_result", "main", { callId: "a", output: "ok" }),
      E(6, "text_delta", "main", { text: "found it" }),
    ];
    const reach = reasoningReach(s);
    expect([...reach.keys()]).toEqual([2, 4, 6]);
  });

  it("counts two agents streaming in turn as two answers, not one", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "thinking_delta", "helper", { text: "…" }),
      E(3, "text_delta", "main", { text: "a" }),
      E(4, "text_delta", "helper", { text: "b" }),
      E(5, "text_delta", "helper", { text: "c" }),
    ];
    const reach = reasoningReach(s);
    expect(reach.get(3)).toBe(1);
    expect(reach.get(4)).toBe(2);
    expect(reach.has(5)).toBe(false);
  });
});

// The whole path, over a real record shape: import the fixture, attach the
// lines the way App.tsx does, and ask the lens what each row says.
describe("the lens over an imported transcript", () => {
  const { events, source } = detectAndLoad(ccSplit);
  const rows = attachSources(
    events.map((e, i) => ({
      seq: i + 1,
      dir: "in" as const,
      ts: (e as { ts: number }).ts,
      type: e.type,
      agentId: (e as { agentId?: string }).agentId,
      payload: e as unknown,
    })),
    events,
    source.origin,
  ) as unknown as TraceEntry[];

  const at = (seq: number): TraceEntry => rows.find((r) => r.seq === seq)!;
  const blocks = reasoningBlockText(rows);
  const reach = reasoningReach(rows);

  it("hands each block's reading to a turn_start", () => {
    // Both of the fixture's responses open with a thinking block written on the
    // same line as the turn — the corpus shape, 16,572 of 16,579 blocks.
    expect(blocks.size).toBeGreaterThan(0);
    for (const seq of blocks.keys()) expect(at(seq).type).toBe("turn_start");
  });

  it("says nothing on a thinking row whose turn_start already speaks", () => {
    for (const r of rows) {
      if (r.type !== "thinking_delta") continue;
      expect(blocks.has(r.seq)).toBe(false);
    }
  });

  it("points a tool call back at the thought that was in charge", () => {
    const calls = rows.filter((r) => r.type === "tool_call");
    const pointed = calls.filter((r) => reach.has(r.seq));
    expect(pointed.length).toBeGreaterThan(0);
    for (const c of pointed) expect(at(reach.get(c.seq)!).type).toBe("turn_start");
    // msg_3 thinks once and then calls twice; the second call answers to the
    // same thought, which is exactly what "then:" alone could never say.
    const under = new Map<number, number>();
    for (const c of pointed) under.set(reach.get(c.seq)!, (under.get(reach.get(c.seq)!) ?? 0) + 1);
    expect([...under.values()].some((n) => n > 1)).toBe(true);
  });

  it("leaves a row with no reasoning behind it silent", () => {
    // The fixture's msg_2 is a bare text response with no thinking anywhere in
    // its turn. Nothing there may sprout a reading.
    const silent = rows.filter((r) => !blocks.has(r.seq) && !reach.has(r.seq));
    expect(silent.length).toBeGreaterThan(0);
    for (const r of silent) {
      expect(blocks.get(r.seq)).toBeUndefined();
      expect(reach.get(r.seq)).toBeUndefined();
    }
  });
});

describe("reasoningLead", () => {
  it("collapses a thought's opening into one line", () => {
    expect(reasoningLead("  first\n\n  second  ")).toBe("first second");
  });

  it("cuts on a word and marks the cut", () => {
    const lead = reasoningLead("alpha beta gamma delta epsilon zeta eta theta iota kappa", 20);
    expect(lead.endsWith("…")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(21);
    expect(lead).not.toContain("kappa");
  });

  it("leaves a short thought whole, with no ellipsis", () => {
    expect(reasoningLead("short one")).toBe("short one");
  });
});

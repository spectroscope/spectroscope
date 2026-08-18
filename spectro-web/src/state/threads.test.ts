// The chat's thread grouping: main turns pass through flat, consecutive
// subagent turns nest into one thread block per child, interleaving splits
// honestly (chronology wins over tidiness).
import { describe, expect, it } from "vitest";
import type { AgentInfo, ToolCard, Turn } from "./reducer";
import { groupTurns, groupTurnsV2, type ChatBlock, type ChatBlockV2 } from "./threads";

const worker: AgentInfo = {
  id: "worker-1",
  parentId: "main",
  label: "build_plan",
  task: "Plan the flag",
  state: "working",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
};

const cards: Record<string, ToolCard> = {
  m1: { callId: "m1", agentId: "main", name: "grep", input: {}, status: "ok", startedAt: 1 },
  k1: { callId: "k1", agentId: "worker-1", name: "write_file", input: {}, status: "ok", startedAt: 2 },
};

const turns: Turn[] = [
  { kind: "user", text: "Do it" },
  { kind: "assistant", agentId: "main", text: "Delegating.", thinking: "" },
  { kind: "info", text: "Subagent worker-1 spawned: Plan the flag", tone: "neutral", agentId: "worker-1" },
  { kind: "assistant", agentId: "worker-1", text: "", thinking: "planning" },
  { kind: "tool", callId: "k1" },
  { kind: "assistant", agentId: "main", text: "Meanwhile on main.", thinking: "" },
  { kind: "assistant", agentId: "worker-1", text: "Done.", thinking: "" },
  { kind: "tool", callId: "m1" },
];

describe("groupTurns", () => {
  const blocks = groupTurns(turns, cards, [worker]);

  it("keeps main turns flat and in order", () => {
    const kinds = blocks.map((b) => (b.kind === "turn" ? b.turn.kind : "thread"));
    expect(kinds).toEqual(["user", "assistant", "thread", "assistant", "thread", "tool"]);
  });

  it("groups consecutive child turns into one thread carrying the roster's task", () => {
    const thread = blocks[2] as Extract<ChatBlock, { kind: "thread" }>;
    expect(thread.agentId).toBe("worker-1");
    expect(thread.task).toBe("Plan the flag");
    expect(thread.label).toBe("build_plan");
    // spawn info + child thinking + child tool = one burst
    expect(thread.items.map((it) => it.turn.kind)).toEqual(["info", "assistant", "tool"]);
  });

  it("splits the thread when main interleaves (chronology wins)", () => {
    const second = blocks[4] as Extract<ChatBlock, { kind: "thread" }>;
    expect(second.kind).toBe("thread");
    expect(second.agentId).toBe("worker-1");
    expect(second.items).toHaveLength(1);
  });

  it("resolves tool ownership through the card and keeps flat indexes", () => {
    const flatTool = blocks[5] as Extract<ChatBlock, { kind: "turn" }>;
    expect(flatTool.turn.kind).toBe("tool");
    expect(flatTool.index).toBe(7);
    const thread = blocks[2] as Extract<ChatBlock, { kind: "thread" }>;
    expect(thread.items[2].index).toBe(4);
  });

  it("threads a child's failure with the rest of its burst", () => {
    // An outage inside a subagent is the child's, and the importer says whose
    // it was; without the owner it broke the burst in two and drew the failure
    // in the main transcript.
    const blocksWithError = groupTurns(
      [
        { kind: "assistant", agentId: "worker-1", text: "", thinking: "planning" },
        { kind: "error", text: "You've hit your session limit", agentId: "worker-1" },
      ],
      {},
      [worker],
    );
    expect(blocksWithError).toHaveLength(1);
    const thread = blocksWithError[0] as Extract<ChatBlock, { kind: "thread" }>;
    expect(thread.agentId).toBe("worker-1");
    expect(thread.items.map((it) => it.turn.kind)).toEqual(["assistant", "error"]);
  });

  it("an unknown child still threads, with an empty task", () => {
    const blocks2 = groupTurns([{ kind: "assistant", agentId: "ghost-9", text: "hi", thinking: "" }], {}, []);
    const th = blocks2[0] as Extract<ChatBlock, { kind: "thread" }>;
    expect(th.kind).toBe("thread");
    expect(th.task).toBe("");
    expect(th.label).toBeNull();
  });
});

describe("groupTurnsV2", () => {
  const blocks = groupTurnsV2(turns, cards);

  it("keeps main turns flat and replaces the child's turns with one chip", () => {
    const kinds = blocks.map((b) => (b.kind === "turn" ? b.turn.kind : "chip"));
    // v1 on this exact fixture yields ["user","assistant","thread","assistant","thread","tool"]:
    // the SAME child appears twice because main streamed between its bursts.
    expect(kinds).toEqual(["user", "assistant", "chip", "assistant", "tool"]);
  });

  it("the chip names the work item and sits where the child first spoke", () => {
    const chip = blocks[2] as Extract<ChatBlockV2, { kind: "chip" }>;
    expect(chip.workIds).toEqual(["worker-1"]);
    expect(chip.index).toBe(2);
  });

  it("a later burst from an already-chipped child leaves no second chip", () => {
    expect(blocks.filter((b) => b.kind === "chip")).toHaveLength(1);
  });

  it("a fan-out that starts together leaves ONE chip naming every child", () => {
    const fan: Turn[] = [
      { kind: "user", text: "review" },
      { kind: "assistant", agentId: "w1", text: "", thinking: "a" },
      { kind: "assistant", agentId: "w2", text: "", thinking: "b" },
      { kind: "assistant", agentId: "w3", text: "", thinking: "c" },
      { kind: "assistant", agentId: "main", text: "back", thinking: "" },
    ];
    const out = groupTurnsV2(fan, {});
    expect(out.map((b) => b.kind)).toEqual(["turn", "chip", "turn"]);
    const chip = out[1] as Extract<ChatBlockV2, { kind: "chip" }>;
    expect(chip.workIds).toEqual(["w1", "w2", "w3"]);
  });

  // ---- card 271: the chip must be able to give the child's words back -------

  it("the chip carries the child's own turns, later bursts included", () => {
    const chip = blocks[2] as Extract<ChatBlockV2, { kind: "chip" }>;
    expect(Object.keys(chip.threads)).toEqual(["worker-1"]);
    // 2,3,4 is the first burst; 6 is the one main interrupted. Today's grouping
    // drops 6 on the floor, and that is the whole defect card 271 names.
    expect(chip.threads["worker-1"].map((it) => it.index)).toEqual([2, 3, 4, 6]);
  });

  it("what the chip carries is what v1 nests FOR THAT CHILD, turn for turn", () => {
    // The reuse rule as an assertion. v1 splits this child across TWO thread
    // blocks because main streamed between its bursts; v2 keeps one list. For
    // the fold to render "as v1 renders it", the two must agree about which
    // turns are the child's — not merely about how many.
    //
    // PER CHILD, and the name says so, because a flat comparison across every
    // child is FALSE and measuring it is how that was learned: on the owner's
    // real three-child archive the two lists hold the same 66 turns in a
    // different order. v1 interleaves the children in stream order; the chip
    // gives each its own section. Within one child both are ascending and
    // identical, which is the claim the fold actually rests on.
    const v1Items = groupTurns(turns, cards, [worker])
      .filter((b): b is Extract<ChatBlock, { kind: "thread" }> => b.kind === "thread")
      .flatMap((b) => b.items);
    const chip = blocks[2] as Extract<ChatBlockV2, { kind: "chip" }>;
    expect(chip.threads["worker-1"]).toEqual(v1Items);
  });

  it("with several children interleaved, each child still matches its own v1 blocks", () => {
    // The case the single-child fixture above cannot reach, and the one the
    // real archive is made of.
    const roster: AgentInfo[] = [worker, { ...worker, id: "worker-2", label: "review", task: "Read it" }];
    const mixed: Turn[] = [
      { kind: "user", text: "go" },
      { kind: "assistant", agentId: "worker-1", text: "a1", thinking: "" },
      { kind: "assistant", agentId: "worker-2", text: "b1", thinking: "" },
      { kind: "assistant", agentId: "worker-1", text: "a2", thinking: "" },
      { kind: "assistant", agentId: "main", text: "meanwhile", thinking: "" },
      { kind: "assistant", agentId: "worker-2", text: "b2", thinking: "" },
    ];
    const chip = groupTurnsV2(mixed, {}, roster)[1] as Extract<ChatBlockV2, { kind: "chip" }>;
    for (const id of ["worker-1", "worker-2"]) {
      const v1ForChild = groupTurns(mixed, {}, roster)
        .filter((b): b is Extract<ChatBlock, { kind: "thread" }> => b.kind === "thread" && b.agentId === id)
        .flatMap((b) => b.items);
      expect(chip.threads[id]).toEqual(v1ForChild);
    }
    // And the ordering difference is deliberate, not accidental: v1 hands back
    // the children interleaved, the chip hands back one list each.
    expect(chip.threads["worker-1"].map((it) => it.index)).toEqual([1, 3]);
    expect(chip.threads["worker-2"].map((it) => it.index)).toEqual([2, 5]);
  });

  it("a fan-out chip keeps each child's turns under its own id", () => {
    const fan: Turn[] = [
      { kind: "user", text: "review" },
      { kind: "assistant", agentId: "w1", text: "", thinking: "a" },
      { kind: "assistant", agentId: "w2", text: "", thinking: "b" },
      { kind: "assistant", agentId: "main", text: "back", thinking: "" },
      { kind: "assistant", agentId: "w1", text: "more", thinking: "" },
    ];
    const chip = groupTurnsV2(fan, {})[1] as Extract<ChatBlockV2, { kind: "chip" }>;
    expect(chip.threads["w1"].map((it) => it.index)).toEqual([1, 4]);
    expect(chip.threads["w2"].map((it) => it.index)).toEqual([2]);
  });

  it("a transcript with no children is untouched", () => {
    const only: Turn[] = [{ kind: "user", text: "hi" }];
    expect(groupTurnsV2(only, {})).toEqual([{ kind: "turn", turn: only[0], index: 0 }]);
  });
});

// Whose transcript is the spine (card 152).
//
// The grouping asked "is this main?" and put everything else in a thread. That
// is right for every session this app produces and for every joined import,
// because their root IS called main. It is wrong for a standalone subagent
// transcript, whose root agent is the id the file names: every turn of the
// conversation answered "no" and the whole transcript collapsed into one
// thread chip inside an otherwise empty session.
//
// The root is read off the roster instead, and "main" still wins wherever a
// main agent exists at all, so nothing that has a main changes.
describe("the spine of a transcript whose root is not called main", () => {
  const root: AgentInfo = {
    id: "a0b476c3c018",
    parentId: null,
    label: null,
    task: "",
    state: "working",
    lastStatus: null,
    inTokens: 0,
    outTokens: 0,
  };
  const child: AgentInfo = { ...root, id: "nested1", parentId: "a0b476c3c018", task: "Count them" };
  const subTurns: Turn[] = [
    { kind: "user", text: "Build the poster" },
    { kind: "assistant", agentId: "a0b476c3c018", text: "Building.", thinking: "" },
    { kind: "assistant", agentId: "nested1", text: "168 files.", thinking: "" },
    { kind: "assistant", agentId: "a0b476c3c018", text: "Done.", thinking: "" },
  ];

  it("reads the root's turns as the transcript, not as a thread", () => {
    const blocks = groupTurns(subTurns, {}, [root, child]);
    expect(blocks.map((b) => b.kind)).toEqual(["turn", "turn", "thread", "turn"]);
    expect((blocks[2] as { agentId: string }).agentId).toBe("nested1");
  });

  it("does the same in the v2 grouping", () => {
    const blocks = groupTurnsV2(subTurns, {}, [root, child]);
    expect(blocks.map((b) => b.kind)).toEqual(["turn", "turn", "chip", "turn"]);
  });

  it("still treats main as the spine wherever a main agent exists", () => {
    // The invariant that keeps every existing session byte-identical: the root
    // is only read off the roster when the roster holds no main at all.
    const withMain: AgentInfo[] = [{ ...root, id: "main" }, worker];
    expect(groupTurns(turns, cards, withMain)).toEqual(groupTurns(turns, cards, [worker]));
    expect(groupTurnsV2(turns, cards, withMain)).toEqual(groupTurnsV2(turns, cards));
  });
});

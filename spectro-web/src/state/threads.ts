// Render-time grouping: the reducer's FLAT turn list (chronological truth,
// shared with the trace) folds into chat blocks — main turns pass through,
// consecutive subagent turns nest into one thread block per child, in stream
// order. Interleaving is preserved honestly: when main streams between two
// child bursts, the thread splits into two blocks. Pure module, no React.
// The nested-thread idea comes from the LLM_Simulator's chat model.

import type { AgentInfo, ToolCard, Turn } from "./reducer";

export interface ThreadItem {
  turn: Turn;
  /** The turn's index in the flat list — live caret/thinking flags key off it. */
  index: number;
}

export type ChatBlock =
  | { kind: "turn"; turn: Turn; index: number }
  | { kind: "thread"; agentId: string; task: string; label: string | null; items: ThreadItem[] };

/**
 * Whose transcript is the spine of this session (card 152).
 *
 * The grouping used to ask "is this main?", which is right for every session
 * this app produces and for every joined import, because their root IS called
 * main. It is wrong for a standalone subagent transcript, whose root agent is
 * the id the file names: every turn of the conversation answered no, and the
 * whole transcript collapsed into one thread chip inside an empty session.
 *
 * Main still wins wherever a main agent exists at all, so nothing that has one
 * changes by a single block. The roster is only consulted for a session that
 * has no main in it, which today is exactly the standalone case.
 */
function rootOf(agents: readonly AgentInfo[]): string {
  if (agents.length === 0) return "main";
  for (const a of agents) if (a.id === "main") return "main";
  for (const a of agents) if (a.parentId === null) return a.id;
  return "main";
}

/** Which agent a flat turn belongs to (tool turns resolve via their card). */
function ownerOf(turn: Turn, cards: Record<string, ToolCard>, root: string): string {
  switch (turn.kind) {
    case "assistant":
      return turn.agentId;
    case "tool":
      return cards[turn.callId]?.agentId ?? root;
    // An error turn owns exactly like an info turn does. Both arrived here
    // separately — main gave `error` its own case, this branch replaced every
    // `?? "main"` with `?? root` — and keeping main's line verbatim would have
    // left one fallback behind: in a standalone transcript there IS no "main",
    // so an unattributed error would own to an agent the roster does not have,
    // fail the owner === root spine and draw a thread chip for nobody.
    case "info":
    case "error":
      return turn.agentId ?? root;
    default:
      return root;
  }
}

/**
 * The v2 grouping (branch chat-v2): a subagent's turns LEAVE the transcript.
 *
 * v1 nests them into thread blocks in stream order, which is a faithful
 * rendering of interleaving and the right default for reading one run closely.
 * It is the wrong rendering for "five agents are working, what is the state of
 * each", because with four parallel children each child appears as several
 * blocks scattered down the scroll.
 *
 * So in v2 the child turns leave the MAIN LINE. At the point where a child
 * first speaks, the transcript keeps a CHIP naming it; adjacent chips merge, so
 * a fan-out of four leaves one chip rather than four, and a later burst from an
 * already-chipped child adds no second chip.
 *
 * <p>Card 271: the chip CARRIES those turns rather than dropping them. Until
 * this card the grouping returned ids alone and the words existed nowhere on
 * screen — not in the transcript, and not in the panel either, because a
 * WorkItem holds numbers and one status line and has no field for text. The
 * turns were never lost on disk; they were lost between the reducer and the
 * render, in this function, on the line that used to read `return`.</p>
 *
 * <p>This is NOT a second fold of the stream. The walk is the same single pass
 * over the same `turns`; it simply keeps what it was throwing away, so a chip's
 * `threads[childId]` is turn-for-turn identical to the items v1 nests into its
 * thread blocks — which is what lets the fold reuse v1's renderer instead of
 * growing a second one. `threads.test.ts` asserts that identity rather than
 * trusting it.</p>
 *
 * The two groupings sit in one file on purpose: they can be diffed by eye.
 */
export type ChatBlockV2 =
  | { kind: "turn"; turn: Turn; index: number }
  /** One or more children starting here. `index` is the first turn they took.
   *  `threads` holds every turn each of them takes — later bursts included, so
   *  the key is the child's id and not the position in `workIds`. */
  | {
      kind: "chip";
      workIds: string[];
      index: number;
      threads: Record<string, ThreadItem[]>;
    };

/** The chip variant, named because the walk below has to mutate one. */
type ChipBlock = Extract<ChatBlockV2, { kind: "chip" }>;

export function groupTurnsV2(
  turns: Turn[],
  cards: Record<string, ToolCard>,
  agents: readonly AgentInfo[] = [],
): ChatBlockV2[] {
  const root = rootOf(agents);
  const blocks: ChatBlockV2[] = [];
  // Which chip announced a given child. A Set of names was enough while later
  // bursts were discarded; now they have to find their way back to the block
  // that speaks for them, which can be far above the current position.
  const announcedBy = new Map<string, ChipBlock>();
  turns.forEach((turn, index) => {
    const owner = ownerOf(turn, cards, root);
    if (owner === root) {
      blocks.push({ kind: "turn", turn, index });
      return;
    }
    const already = announcedBy.get(owner);
    if (already !== undefined) {
      already.threads[owner].push({ turn, index });
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === "chip") {
      last.workIds.push(owner);
      last.threads[owner] = [{ turn, index }];
      announcedBy.set(owner, last);
      return;
    }
    const chip: ChipBlock = {
      kind: "chip",
      workIds: [owner],
      index,
      threads: { [owner]: [{ turn, index }] },
    };
    blocks.push(chip);
    announcedBy.set(owner, chip);
  });
  return blocks;
}

export function groupTurns(turns: Turn[], cards: Record<string, ToolCard>, agents: AgentInfo[]): ChatBlock[] {
  const root = rootOf(agents);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const blocks: ChatBlock[] = [];
  turns.forEach((turn, index) => {
    const owner = ownerOf(turn, cards, root);
    if (owner === root) {
      blocks.push({ kind: "turn", turn, index });
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === "thread" && last.agentId === owner) {
      last.items.push({ turn, index });
      return;
    }
    const info = byId.get(owner);
    blocks.push({
      kind: "thread",
      agentId: owner,
      task: info?.task ?? "",
      label: info?.label ?? null,
      items: [{ turn, index }],
    });
  });
  return blocks;
}

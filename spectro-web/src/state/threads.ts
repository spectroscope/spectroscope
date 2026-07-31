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

/** Which agent a flat turn belongs to (tool turns resolve via their card). */
function ownerOf(turn: Turn, cards: Record<string, ToolCard>): string {
  switch (turn.kind) {
    case "assistant":
      return turn.agentId;
    case "tool":
      return cards[turn.callId]?.agentId ?? "main";
    case "info":
      return turn.agentId ?? "main";
    default:
      return "main";
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
 * So in v2 the child turns are not rendered at all. At the point where a child
 * first speaks, the transcript keeps a CHIP naming it; adjacent chips merge, so
 * a fan-out of four leaves one chip rather than four. Every later burst from an
 * already-chipped child is dropped, because the panel on the right is where its
 * state lives — and nothing is lost, since the trace still holds every frame.
 *
 * The two groupings sit in one file on purpose: they can be diffed by eye.
 */
export type ChatBlockV2 =
  | { kind: "turn"; turn: Turn; index: number }
  /** One or more children starting here. `index` is the first turn they took. */
  | { kind: "chip"; workIds: string[]; index: number };

export function groupTurnsV2(turns: Turn[], cards: Record<string, ToolCard>): ChatBlockV2[] {
  const blocks: ChatBlockV2[] = [];
  const chipped = new Set<string>();
  turns.forEach((turn, index) => {
    const owner = ownerOf(turn, cards);
    if (owner === "main") {
      blocks.push({ kind: "turn", turn, index });
      return;
    }
    if (chipped.has(owner)) return; // already announced; its state lives right
    chipped.add(owner);
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === "chip") {
      last.workIds.push(owner);
      return;
    }
    blocks.push({ kind: "chip", workIds: [owner], index });
  });
  return blocks;
}

export function groupTurns(turns: Turn[], cards: Record<string, ToolCard>, agents: AgentInfo[]): ChatBlock[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const blocks: ChatBlock[] = [];
  turns.forEach((turn, index) => {
    const owner = ownerOf(turn, cards);
    if (owner === "main") {
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

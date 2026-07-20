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

export function groupTurns(
  turns: Turn[],
  cards: Record<string, ToolCard>,
  agents: AgentInfo[],
): ChatBlock[] {
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

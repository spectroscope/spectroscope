// Card 271, criterion 7: the consumer pinned on its REAL call shape.
//
// The fold's decision is pure and pinned in state/childFold.test.ts. What that
// cannot see is whether the component actually ASKS it, and — the whole point
// of the card — whether the turns it draws come from v1's renderer or from a
// second one grown quietly beside it. Card 247 paid for this distinction: a
// loose substring check let a dead consumer pass green there, so every
// assertion here names the call as it is written, arguments included.
//
// Comments are blanked first. The prose above these very lines quotes the
// shapes the assertions look for, and a blanker that missed them would let a
// COMMENT satisfy an assertion about CODE — the trap testkit/source.ts was
// extracted to close.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));
const chatV2 = stripComments(read("./ChatV2.tsx", import.meta.url));
const threads = stripComments(read("../state/threads.ts", import.meta.url));

/** The chip branch of Chat's block map — where the fold is drawn, or is not. */
function chipBranch(src: string): string {
  const from = src.indexOf('b.kind === "chip"');
  expect(from).toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("key={`${vk}:thread-", from));
}

describe("the fold is drawn by v1's renderer, not by a second one", () => {
  it("the chip branch renders turns with renderTurn's in-thread call shape", () => {
    // The exact form v1 uses for a nested child, at Chat.tsx's thread block:
    // renderTurn(it.turn, it.index, true). Not `renderTurn(it.turn, it.index)`,
    // whose default would render the child as a MAIN turn and lose the nesting
    // this card exists to give back.
    expect(chipBranch(chat)).toContain("renderTurn(it.turn, it.index, true)");
  });

  it("v1's own thread block still renders with the very same call", () => {
    // If this ever diverges, the two readings have stopped agreeing and the
    // reuse rule has quietly become two implementations.
    const v1Thread = chat.slice(chat.indexOf("key={`${vk}:thread-"));
    expect(v1Thread).toContain("renderTurn(it.turn, it.index, true)");
  });

  it("Chat asks childFold which children to draw instead of deciding inline", () => {
    expect(chipBranch(chat)).toContain("foldedTurns(b.threads, b.workIds, childFolds, vk)");
  });

  it("the opened child wears v1's own container class", () => {
    // Same class, so it inherits v1's rules rather than a parallel set that can
    // drift away from them.
    expect(chipBranch(chat)).toContain('className="chat-thread chat-thread--folded"');
  });
});

describe("the chip is a control, and the grouping still feeds it", () => {
  it("Chat hands the chip a toggle bound to that chip's own block", () => {
    expect(chipBranch(chat)).toContain("toggle: (agentId) => toggleChildFold(agentId, b.index)");
  });

  it("the chip row carries the handle the scroll rule measures it by", () => {
    expect(chipBranch(chat)).toContain("data-chip-index={b.index}");
  });

  it("ChatV2's chip body toggles the fold and does NOT jump to the panel", () => {
    // The card's criterion 6, decided: two jobs, two surfaces. If the body ever
    // goes back to calling onOpenWork, the confusion this card ended is back.
    const body = chatV2.slice(chatV2.indexOf("className={`work-chip-btn"), chatV2.indexOf("work-chip-jump"));
    expect(body).toContain("onClick={() => fold.toggle(id)}");
    expect(body).not.toContain("onOpenWork");
  });

  it("the panel jump keeps its own button", () => {
    const jump = chatV2.slice(chatV2.indexOf("work-chip-jump"));
    expect(jump).toContain("onClick={() => props.onOpenWork?.(id)}");
  });

  it("the body says whether it is open, in the attribute and not only in a label", () => {
    expect(chatV2).toContain("aria-expanded={open}");
  });

  it("the grouping still carries the turns the fold renders", () => {
    // The chip block's threads field is the single source: if the grouping goes
    // back to dropping later bursts, the fold has nothing to show and this says
    // so here rather than three files away.
    expect(threads).toContain("already.threads[owner].push({ turn, index });");
  });
});

describe("v1 is untouched", () => {
  it("both readings are still offered", () => {
    const chatView = stripComments(read("../state/chatView.ts", import.meta.url));
    expect(chatView).toContain('export const CHAT_VIEW_MODES: ChatViewMode[] = ["v1", "v2"];');
  });

  it("v1 still groups through groupTurns, with the roster", () => {
    expect(chat).toContain("groupTurns(state.turns, state.cards, state.agents)");
  });

  it("the fold reaches v2 only — v1 emits no chip block to hang it on", () => {
    const v1 = stripComments(read("../state/threads.ts", import.meta.url));
    const groupTurnsV1 = v1.slice(v1.indexOf("export function groupTurns("));
    expect(groupTurnsV1).not.toContain("chip");
  });
});

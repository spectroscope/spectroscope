// Card 496, final round: the Chat component hands the session's AI credits
// from its state to the block under the composer, which opens the ring that
// names them. The live view and an archive both do. A title call's credits
// count for the session and move nothing else.
//
// The Chat component is driven with the drive() probe (no DOM, house rule).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chat } from "./Chat";
import { ComposerMeta } from "./ComposerMeta";
import { ContextPopover, ContextRing } from "./ContextRing";
import { initialState, reduce, type UiState } from "../state/reducer";
import { TITLE_AGENT_ID, type RunEvent } from "../events";
import { drive, type El } from "../testkit/driveComponent";
import { read } from "../testkit/source";
import { __resetSkillList } from "../state/skillList";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
});

const composerMeta = {
  provider: "copilot",
  model: "claude-sonnet-5",
  status: "open" as const,
  onApplyProvider: () => {},
};

function chat(state: UiState, liveView: boolean) {
  return (
    <Chat
      state={state}
      liveView={liveView}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
      composerMeta={composerMeta}
    />
  );
}

/** The ComposerMeta elements the Chat component renders for a state. */
function metas(state: UiState, liveView: boolean): El[] {
  return drive(chat(state, liveView), [Chat], []).filter((el) => el.type === ComposerMeta);
}

const openRing = (tree: El[]): void => {
  const ring = tree.filter((el) => el.type === "button" && el.props.className === "context-ring");
  if (ring.length !== 1) throw new Error(`expected one ring button, found ${ring.length}`);
  (ring[0].props.onClick as () => void)();
};

describe("the Chat component and the session's AI credits", () => {
  const spent: UiState = { ...initialState, aiCredits: 2.2344, lastInputTokens: 8890 };

  it("hands state.aiCredits to the block under the live composer", () => {
    const found = metas(spent, true);
    expect(found).toHaveLength(1);
    expect(found[0].props.aiCredits).toBe(2.2344);
  });

  it("and to the archive bar's block", () => {
    const found = metas(spent, false);
    expect(found).toHaveLength(1);
    expect(found[0].props.aiCredits).toBe(2.2344);
  });

  it("whose ring opens on the line that names them", () => {
    const meta = metas(spent, true)[0];
    const popover = drive(meta, [ComposerMeta, ContextRing], [openRing]).filter(
      (el) => el.type === ContextPopover,
    );
    expect(popover).toHaveLength(1);
    expect(renderToStaticMarkup(popover[0])).toContain("AI credits this session · 2.23");
  });

  it("hands null on when the session reported no credits", () => {
    const found = metas({ ...spent, aiCredits: null }, true);
    expect(found[0].props.aiCredits).toBeNull();
  });
});

describe("a title call's credits", () => {
  const usage = (agentId: string, aiCredits: number, inputTokens: number): RunEvent => ({
    type: "usage",
    agentId,
    inputTokens,
    outputTokens: 3,
    aiCredits,
    ts: 1,
  });

  it("count for the session's total and the session's tokens", () => {
    const after = reduce(
      reduce(initialState, usage("main", 2.2344, 8890)),
      usage(TITLE_AGENT_ID, 0.0412, 120),
    );
    expect(after.aiCredits).toBeCloseTo(2.2756, 9);
    expect(after.usage.inputTokens).toBe(8890 + 120);
  });

  it("move neither the ring's gauge, nor the run's figures, nor the list of children", () => {
    const before = reduce(initialState, usage("main", 2.2344, 8890));
    const after = reduce(before, usage(TITLE_AGENT_ID, 0.0412, 120));
    expect(after.lastInputTokens).toBe(before.lastInputTokens);
    expect(after.runUsage).toEqual(before.runUsage);
    expect(after.runSubagents).toEqual(before.runSubagents);
    expect(after.turns).toBe(before.turns);
  });

  it("are billed to the agent the server names", () => {
    const java = read(
      "../../../spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java",
      import.meta.url,
    );
    const declared = /static final String TITLE_AGENT_ID = "([^"]+)";/.exec(java);
    expect(declared, "SessionConnection.java no longer declares TITLE_AGENT_ID").not.toBeNull();
    expect(TITLE_AGENT_ID).toBe(declared![1]);
  });
});

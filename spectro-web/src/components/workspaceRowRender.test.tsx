// Card 389 criterion 8 and card 428: the chat as rendered, before and after its
// first prompt, live and archived. Server renderer, no DOM: the markup is the
// first paint for a given state, and the row is found by its class inside the
// composer column. Card 428 narrowed card 389's "on every live chat" to the
// time before the first prompt starts a run (owner, 2026-09-25).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { initialState, recordOutgoing, reduceAll, type UiState } from "../state/reducer";
import { drive, type El } from "../testkit/driveComponent";
import { Chat } from "./Chat";
import { WorkspaceChooser } from "./WorkspaceChooser";

const DEFAULT_FOLDER = "/Users/you/work";

const announced: RunEvent[] = [
  {
    type: "workspace_info",
    resolved: false,
    mode: "default",
    configured: true,
    path: DEFAULT_FOLDER,
    exists: true,
    ts: 1,
  } as unknown as RunEvent,
];

/** The first run's start, as SessionConnection streams it. */
const firstRunStart: RunEvent = { type: "run_start", runId: "r0", agentId: "main", prompt: "first", ts: 10 };

/** Six finished runs, twelve turns: a prompt and an answer each. */
function twelveTurns(): RunEvent[] {
  const out: RunEvent[] = [];
  for (let i = 0; i < 6; i++) {
    out.push(
      { type: "run_start", runId: `r${i}`, agentId: "main", prompt: `prompt ${i}`, ts: 10 + 3 * i },
      { type: "text_delta", agentId: "main", text: `answer ${i}`, ts: 11 + 3 * i },
      { type: "run_end", runId: `r${i}`, stopReason: "end_turn", ts: 12 + 3 * i },
    );
  }
  return out;
}

function chat(state: UiState, liveView: boolean, sendClient: (m: ClientMessage) => boolean = () => true) {
  return (
    <Chat
      state={state}
      liveView={liveView}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={sendClient}
      onPickFolder={() => {}}
    />
  );
}

function markup(state: UiState, liveView: boolean): string {
  return renderToStaticMarkup(chat(state, liveView));
}

/** Where the row sits relative to the live column and its input box. */
function placement(html: string): { row: number; column: number; box: number } {
  return {
    row: html.indexOf('class="ws-chooser"'),
    column: html.indexOf('class="composer-column"'),
    box: html.indexOf('class="composer-inner'),
  };
}

/** The row is drawn in the composer column, above the input box. */
function expectRowAboveTheBox(html: string): void {
  const p = placement(html);
  expect(p.column).toBeGreaterThanOrEqual(0);
  expect(p.row).toBeGreaterThan(p.column);
  expect(p.row).toBeLessThan(p.box);
}

/** The live composer is drawn, and the row is not in the markup at all. */
function expectNoRow(html: string): void {
  const p = placement(html);
  expect(p.column).toBeGreaterThanOrEqual(0);
  expect(p.box).toBeGreaterThan(p.column);
  expect(html).not.toContain("ws-chooser");
}

const anyOptionDisabled = /<button[^>]*data-option="[a-z]+"[^>]*disabled=""/;

describe("the working folder row before the first prompt (card 389, card 428)", () => {
  it("renders above the input box on a chat with no turns", () => {
    const state = reduceAll(initialState, announced);
    expect(state.turns).toHaveLength(0);
    expectRowAboveTheBox(markup(state, true));
  });

  it("leaves the options enabled before the first run", () => {
    const html = markup(reduceAll(initialState, announced), true);
    expect(html).toMatch(/<button[^>]*data-option="random"/);
    expect(html).not.toMatch(anyOptionDisabled);
  });
});

describe("the row leaves with the first run (card 428, criterion 2)", () => {
  it("is gone, not merely disabled, on a chat with twelve turns", () => {
    const state = reduceAll(initialState, [...announced, ...twelveTurns()]);
    expect(state.turns.length).toBeGreaterThanOrEqual(12);
    expectNoRow(markup(state, true));
  });

  it("is gone from the first run_start on, while that run still streams", () => {
    const state = reduceAll(initialState, [...announced, firstRunStart]);
    expect(state.running).toBe(true);
    expect(state.turns.map((t) => t.kind)).toEqual(["user"]);
    expectNoRow(markup(state, true));
  });
});

describe("a first message that never started a run keeps the row (card 428, criterion 3)", () => {
  /** The state right after the composer put the first prompt on the wire. */
  const afterLocalSend = (): UiState =>
    recordOutgoing(reduceAll(initialState, announced), { type: "user_message", text: "first" });

  it("keeps the row, enabled, after the local send and before any run_start", () => {
    const state = afterLocalSend();
    // The local act of sending happened: the outgoing frame is in the state.
    expect(state.trace.some((e) => e.dir === "out" && e.type === "user_message")).toBe(true);
    expect(state.turns).toHaveLength(0);
    const html = markup(state, true);
    expectRowAboveTheBox(html);
    expect(html).not.toMatch(anyOptionDisabled);
  });

  it("keeps the row, enabled, when the server refuses that prompt with an error", () => {
    const state = reduceAll(afterLocalSend(), [
      { type: "error", message: "Unsupported attachment type: application/zip", ts: 5 },
    ]);
    // The refusal is a turn of its own; no prompt reached a run.
    expect(state.turns.map((t) => t.kind)).toEqual(["error"]);
    const html = markup(state, true);
    expectRowAboveTheBox(html);
    expect(html).not.toMatch(anyOptionDisabled);
  });

  it("keeps the row, enabled, when the server rejects a folder picked before any prompt", () => {
    const state = reduceAll(initialState, [
      ...announced,
      { type: "error", message: "Workspace rejected: not a directory", ts: 5 },
    ]);
    expect(state.turns.map((t) => t.kind)).toEqual(["error"]);
    const html = markup(state, true);
    expectRowAboveTheBox(html);
    expect(html).not.toMatch(anyOptionDisabled);
  });
});

describe("a resumed, imported or archived session never shows the row (card 428, criterion 6)", () => {
  it("draws no row on the first render of a live chat that already carries turns", () => {
    // A resume replays the stored run_start events, so the chat has its turns
    // before the row could ever have been drawn.
    const resumed = reduceAll(initialState, [...announced, ...twelveTurns()]);
    expectNoRow(markup(resumed, true));
  });

  it("draws no row for an imported transcript, whose prompts arrive as user_message", () => {
    const imported = reduceAll(initialState, [
      ...announced,
      { type: "user_message", text: "an imported prompt", ts: 2 } as unknown as RunEvent,
      { type: "text_delta", agentId: "main", text: "an imported answer", ts: 3 },
    ]);
    expect(imported.turns.map((t) => t.kind)).toContain("user");
    expectNoRow(markup(imported, true));
  });

  it("draws no row in the archive bar, with or without turns (card 389, criterion 8)", () => {
    for (const state of [
      reduceAll(initialState, announced),
      reduceAll(initialState, [...announced, ...twelveTurns()]),
    ]) {
      const archive = markup(state, false);
      // A screen that really is the archive bar, with its column.
      expect(archive).toContain("archive-bar");
      expect(archive).toContain('class="composer-column"');
      expect(archive).not.toContain("ws-chooser");
    }
  });
});

describe("a folder picked before the first message (card 428, criterion 7)", () => {
  const press =
    (option: string) =>
    (tree: El[]): void => {
      const b = tree.find((el) => el.type === "button" && el.props["data-option"] === option);
      if (b === undefined) throw new Error(`no button for ${option}`);
      b.props.onClick?.();
    };

  it("sends the pick from the row in the chat, and the row leaves once the run starts there", () => {
    const frames: ClientMessage[] = [];
    const before = reduceAll(initialState, [
      {
        type: "workspace_info",
        resolved: false,
        mode: "random",
        configured: false,
        ts: 1,
      } as unknown as RunEvent,
    ]);
    drive(
      chat(before, true, (m) => {
        frames.push(m);
        return true;
      }),
      [Chat, WorkspaceChooser],
      [press("default")],
    );
    expect(frames).toEqual([{ type: "set_workspace", mode: "default" }]);

    // The server answers the pick with one resolved frame for the pinned
    // folder. The first prompt sends no second one: sendWorkspaceInfo has
    // latched workspaceAnnounced on the pick, so the next frame is run_start.
    const resolved = {
      type: "workspace_info",
      resolved: true,
      mode: "set",
      configured: true,
      exists: true,
      sessionId: "s-428",
      path: DEFAULT_FOLDER,
      ts: 2,
    } as unknown as RunEvent;
    const picked = reduceAll(before, [resolved]);
    expectRowAboveTheBox(markup(picked, true));
    const running = reduceAll(recordOutgoing(picked, { type: "user_message", text: "first" }), [
      firstRunStart,
    ]);
    // The run keeps the folder the pick announced; no frame after the pick names it again.
    expect(running.workspace?.path).toBe(DEFAULT_FOLDER);
    expectNoRow(markup(running, true));
  });
});

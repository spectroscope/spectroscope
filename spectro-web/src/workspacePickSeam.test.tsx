// Card 428, review of 2026-09-25: the Files tab's "choose folder" button and
// the working folder row above the composer offer the same choice, so they
// must give the same answer. The row is drawn, enabled, until the first prompt
// starts a run (Chat.tsx and beforeFirstPrompt); App.tsx hands the Files tab
// `canPickWorkspace`. After a prompt the server refused, the row offered the
// change while the button stayed disabled.
//
// The suite runs in plain Node and does not mount App. This file parses
// App.tsx, takes the initializer of `canPickWorkspace`, and evaluates it
// against states the real reducer builds. The row's answer for the same state
// comes from the rendered Chat.

import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Chat } from "./components/Chat";
import type { RunEvent } from "./events";
import { initialState, recordOutgoing, reduceAll, type UiState } from "./state/reducer";
import { beforeFirstPrompt } from "./workspace/chooserMode";

const APP = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

/** The initializer text of the one `const canPickWorkspace` in App.tsx. */
function initializerOf(name: string): string {
  const file = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (node.initializer !== undefined) found.push(node.initializer.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found.length !== 1) throw new Error(`App.tsx declares ${name} ${found.length} times`);
  return found[0];
}

/** App's expression as a function of the names it reads. */
const appCanPick = new Function(
  "viewingLive",
  "live",
  "beforeFirstPrompt",
  `return (${initializerOf("canPickWorkspace")});`,
) as (viewingLive: boolean, live: UiState, before: typeof beforeFirstPrompt) => boolean;

const canPickWorkspace = (viewingLive: boolean, live: UiState): boolean =>
  appCanPick(viewingLive, live, beforeFirstPrompt);

/** Whether the live chat draws the row with every option enabled. */
function rowOpen(state: UiState): boolean {
  const html = renderToStaticMarkup(
    <Chat
      state={state}
      liveView
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
      onPickFolder={() => {}}
    />,
  );
  return (
    html.includes('class="ws-chooser"') && !/<button[^>]*data-option="[a-z]+"[^>]*disabled=""/.test(html)
  );
}

const announced = {
  type: "workspace_info",
  resolved: false,
  mode: "default",
  configured: true,
  path: "/Users/you/work",
  exists: true,
  ts: 1,
} as unknown as RunEvent;

const firstRunStart: RunEvent = { type: "run_start", runId: "r0", agentId: "main", prompt: "first", ts: 10 };

const newChat = (): UiState => reduceAll(initialState, [announced]);
const afterLocalSend = (): UiState => recordOutgoing(newChat(), { type: "user_message", text: "first" });

/** [name, state, the answer both controls must give] */
const CASES: [string, () => UiState, boolean][] = [
  ["a new chat", newChat, true],
  ["the first prompt sent, no run_start yet", afterLocalSend, true],
  [
    // runPrompt's own words when buildAgentOnce throws, as measured for card 428
    // (kanban evidence 06a): an error event, no run_start, the agent still unset.
    "the first prompt ending in an error before any run_start",
    () =>
      reduceAll(afterLocalSend(), [
        {
          type: "error",
          message: "Run ended with an error: ANTHROPIC_API_KEY is not set (export ANTHROPIC_API_KEY=...).",
          ts: 5,
        },
      ]),
    true,
  ],
  [
    "a folder pick rejected before any prompt",
    () => reduceAll(newChat(), [{ type: "error", message: "Workspace rejected: not a directory", ts: 5 }]),
    true,
  ],
  ["the first run streaming", () => reduceAll(newChat(), [firstRunStart]), false],
  [
    "the first run finished",
    () =>
      reduceAll(newChat(), [
        firstRunStart,
        { type: "text_delta", agentId: "main", text: "done", ts: 11 },
        { type: "run_end", runId: "r0", stopReason: "end_turn", ts: 12 },
      ]),
    false,
  ],
];

describe("the Files tab and the working folder row agree on whether the folder can change (card 428)", () => {
  for (const [name, state, open] of CASES) {
    it(`${name}: both say ${open ? "yes" : "no"}`, () => {
      const s = state();
      expect(rowOpen(s)).toBe(open);
      expect(canPickWorkspace(true, s)).toBe(open);
    });
  }

  it("offers nothing on the Files tab while an archived session is shown", () => {
    expect(canPickWorkspace(true, newChat())).toBe(true);
    expect(canPickWorkspace(false, newChat())).toBe(false);
  });
});

// Card 382, fix round 2026-09-24: scrubbing the Lab asks nothing.
//
// The owner: "wenn man im Lab durchscrubbt ... dann kommt der Permission
// Request noch mal und man kann noch mal ablehnen". The measured cause was the
// Lab's own window reading the stepper's folded prefix. This renders the real
// LabView at the cursor where the prefix holds the answered request, which is
// the exact spot the old window came back, and asks the markup for a window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-mock="reactflow">{children}</div>,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
  useNodesState: () => [[], () => {}, () => {}],
  useEdgesState: () => [[], () => {}, () => {}],
  getSmoothStepPath: () => ["M0,0 L1,1", 0, 0],
}));

import { LabView } from "./LabView";
import type { RunEvent } from "../events";
import { __getState, __resetForTests, backToLive, seek } from "../state/stepper";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";

const td = (i: number): RunEvent => ({ type: "text_delta", agentId: "main", text: `t${i}`, ts: i });

/** The card's seven-event live run: request at index 4, decision at index 5. */
const events: RunEvent[] = [
  td(1),
  td(2),
  { type: "tool_call", agentId: "main", callId: "c1", name: "Bash", input: { command: "ls" }, ts: 3 },
  td(4),
  {
    type: "permission_request",
    agentId: "main",
    callId: "c1",
    name: "Bash",
    input: { command: "ls" },
    ts: 5,
  },
  { type: "permission_decision", callId: "c1", allowed: true, ts: 6 },
  td(7),
];

beforeEach(() => {
  __resetForTests();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  setLang("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrubbing a live run in the Lab asks nothing", () => {
  it("draws no permission window where the prefix holds an answered request", () => {
    backToLive(events);
    seek(7);
    seek(0);
    seek(5);
    // The trap is armed: this is the prefix the old window read.
    expect(__getState().source).toBe("live");
    expect(__getState().ui.pendingPermissions.map((p) => p.callId)).toEqual(["c1"]);

    const html = renderToStaticMarkup(
      <LabView
        replay={null}
        liveEvents={events}
        running={true}
        onSend={() => {}}
        onReturnToLive={() => {}}
        sendClient={() => true}
      />,
    );
    // The positive half first, so an empty render cannot pass: the Lab drew.
    expect(html).toContain(`aria-label="${dict["lab.lensAria"].en}"`);
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain(dict["perm.wants"].en);
    expect(html).not.toContain(`>${dict["perm.deny"].en}</button>`);
  });
});

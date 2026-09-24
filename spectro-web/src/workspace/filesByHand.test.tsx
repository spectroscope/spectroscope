// Card 402, criterion 4: with the automatic open gone, the Files panel still
// shows the resolved folder once the operator opens it by hand.
//
// The removed effect only ever flipped two layout fields. What the pane draws
// comes from the workspace announcement the reducer stores and from paneState,
// which keeps the prospective connect-time folder apart from the resolved one.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { RightPanel } from "../components/RightPanel";
import type { RunEvent } from "../events";
import { __getState, __resetForTests, openDockPanel, openRightPanel } from "../state/layout";
import { initialState, reduceAll } from "../state/reducer";
import { listableBeforeTheFirstRun, paneState } from "./paneState";

const frame = (fields: Record<string, unknown>): RunEvent =>
  ({ type: "workspace_info", ts: 1, ...fields }) as unknown as RunEvent;

// A configured folder that exists: the connect-time frame names it, so a tree
// of it may be drawn before the first run, as the first run's folder.
const connect = frame({
  resolved: false,
  mode: "set",
  configured: true,
  path: "/work/prospective",
  exists: true,
});
const resolved = frame({
  resolved: true,
  mode: "set",
  configured: true,
  exists: true,
  sessionId: "s-402",
  path: "/work/resolved",
});

/** The header's Files icon on a closed panel (headerPanelControls.tsx, press). */
function pressFilesIcon(): void {
  openDockPanel("files");
  openRightPanel(true);
}

function renderDock(workspace: ReturnType<typeof reduceAll>["workspace"]): string {
  return renderToStaticMarkup(
    <RightPanel agents={[]} plan={null} onClose={() => {}} thinking workspace={workspace} sessionId={null} />,
  );
}

beforeEach(() => __resetForTests());

describe("Files, opened by hand after the workspace resolved (card 402)", () => {
  it("before the first message the pane would show the connect-time folder, as the first run's", () => {
    const live = reduceAll(initialState, [connect]);
    expect(listableBeforeTheFirstRun(live.workspace)).toBe(true);
    expect(paneState(live.workspace, { kind: "ok" }, "en")).toEqual({ kind: "tree", scope: "prospective" });
  });

  it("after it, the header's Files icon opens the dock on Files and the pane is the resolved session's", () => {
    const live = reduceAll(initialState, [connect, resolved]);
    expect(__getState().rightPanelOpen).toBe(false);

    pressFilesIcon();
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockFiles).toBe("open");
    expect(renderDock(live.workspace)).toContain('data-panel="files"');

    // WorkspaceTab asks /api/files?session=<id> whenever the announcement
    // carries a session id, and scope=prospective only when it does not.
    expect(live.workspace?.sessionId).toBe("s-402");
    expect(live.workspace?.path).toBe("/work/resolved");
    expect(listableBeforeTheFirstRun(live.workspace)).toBe(false);
    expect(paneState(live.workspace, { kind: "ok" }, "en")).toEqual({ kind: "tree", scope: "session" });
  });
});

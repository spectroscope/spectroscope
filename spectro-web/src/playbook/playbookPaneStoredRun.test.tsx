// Card 482, fix round: the playbook pane shows the run view of a stored
// session even when no playbook is pinned to a workspace there.
//
// Measured 2026-10-10 (kanban/evidence/482, run6-child-reload.json): after a
// reload, the Playbook segment of the finished run's session showed the folder
// list and no run view. A stored session has no live workspace, so no folder
// loads, and the run view sat inside the branch for a loaded playbook. The
// run view draws its own graph from the run's graph file and needs only the
// session id.

import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripComments } from "../testkit/source";
import { __resetPlaybooks } from "../state/playbooks";
import { PlaybookPane } from "./PlaybookPane";

vi.mock("./PlaybookRunView", () => ({
  PlaybookRunView: ({ sessionId }: { sessionId: string }) => <section data-run-view={sessionId} />,
}));

beforeEach(() => {
  __resetPlaybooks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

describe("the playbook pane of a stored session (card 482)", () => {
  it("shows the run view of the session it is given, with no workspace and no playbook loaded", () => {
    const out = renderToStaticMarkup(
      <PlaybookPane workspace={null} sessionId="20261010-113710-959cacce" onStartPlaybook={() => false} />,
    );
    expect(out).toContain('data-run-view="20261010-113710-959cacce"');
    expect(out).not.toContain("pb-run-build");
  });

  it("shows no run view without a session", () => {
    const out = renderToStaticMarkup(
      <PlaybookPane workspace={null} sessionId={null} onStartPlaybook={() => false} />,
    );
    expect(out).not.toContain("data-run-view");
  });

  it("App hands the pane the session it shows, a stored one included", () => {
    const app = stripComments(readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8"));
    const pane = /<PlaybookPane([\s\S]*?)\/>/.exec(app)?.[1] ?? "";
    expect(pane, "App renders the PlaybookPane").not.toBe("");
    expect(pane).toMatch(/sessionId=\{playbookSessionId\(/);
    expect(pane).toMatch(/replay\?\.id \?\? null/);
  });
});

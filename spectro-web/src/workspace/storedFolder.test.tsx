// Card 421: a stored session reopened from the sidebar names the folder it ran in.
//
// A replay folds the session's JSONL alone, and the workspace_info frame is
// socket-only, so the Files pane got no announcement and said "no workspace
// yet, the first run creates it" over a session that had already run. Since
// card 284 the run_start of a run Agent.java started with a cwd carries that
// folder, and the server's SessionStore.recordedWorkspace reads the first one
// to resume a session in the right place. A triggered node's run_start does
// not carry it (card 439), nor does one written before card 284 (card 437).

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { RightPanel } from "../components/RightPanel";
import type { RunEvent } from "../events";
import { __resetForTests, openDockPanel, openRightPanel } from "../state/layout";
import type { WorkspaceInfo } from "../state/reducer";
import { paneState, recordedWorkspace } from "./paneState";
import { storedCwdOf, storedFolderOf, storedWorkspace } from "./storedFolder";

const runStart = (fields: Record<string, unknown>): RunEvent =>
  ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "hi",
    ts: 1,
    ...fields,
  }) as unknown as RunEvent;
const runEnd = {
  type: "run_end",
  runId: "r1",
  agentId: "main",
  reason: "done",
  ts: 2,
} as unknown as RunEvent;

const live: WorkspaceInfo = {
  resolved: true,
  mode: "recorded",
  configured: false,
  exists: true,
  sessionId: "s-421",
  path: "/work/live",
} as WorkspaceInfo;

/** The dock on its Files panel, rendered once, the way the header's icon opens it. */
function filesPanel(props: { storedCwd?: string | null; recordedCwd?: string | null }): string {
  openDockPanel("files");
  openRightPanel(true);
  return renderToStaticMarkup(
    <RightPanel
      agents={[]}
      plan={null}
      onClose={() => {}}
      thinking
      workspace={null}
      sessionId={null}
      {...props}
    />,
  );
}

beforeEach(() => __resetForTests());

describe("the pane with no announcement and no folder on record (criterion 1)", () => {
  it("with no announcement and no recorded folder, paneState promises a first run", () => {
    // Before card 421 every stored session reopened from the sidebar ended
    // here, in paneState with no announcement. Now a stored session ends here
    // only when no run_start in its file names a folder.
    const pane = paneState(null, null, "en");
    expect(pane.kind).toBe("pending");
    expect(pane.kind === "pending" ? pane.message : "").toBe("no workspace yet, the first run creates it");
    expect(recordedWorkspace(null, null, "en")).toBeNull();
  });
});

describe("storedFolderOf: the folder a session's own record names", () => {
  it("reads the workspace the run_start carries", () => {
    expect(storedFolderOf([runStart({ workspace: "/work/ran-here" }), runEnd])).toBe("/work/ran-here");
  });

  it("takes the FIRST run that named a folder, as SessionStore.recordedWorkspace does", () => {
    const events = [
      runStart({ runId: "r1", workspace: "/work/first" }),
      runEnd,
      runStart({ runId: "r2", workspace: "/work/second" }),
    ];
    expect(storedFolderOf(events)).toBe("/work/first");
  });

  it("skips a run_start that names no folder or a blank one", () => {
    const events = [
      runStart({ runId: "r0" }),
      runStart({ runId: "r1", workspace: "  " }),
      runStart({ workspace: "/w" }),
    ];
    expect(storedFolderOf(events)).toBe("/w");
  });

  it("has nothing when no run ever named a folder", () => {
    expect(storedFolderOf([])).toBeNull();
    expect(storedFolderOf([runStart({}), runEnd])).toBeNull();
  });
});

describe("storedCwdOf: only a session this app stored", () => {
  const events = [runStart({ workspace: "/work/ran-here" })];

  it("names the folder of a stored session", () => {
    expect(storedCwdOf({ id: "20260925-101500-abcd", events })).toBe("/work/ran-here");
  });

  it("says nothing for the live view, an import or a scenario", () => {
    expect(storedCwdOf(null)).toBeNull();
    // An import has card 291's own path and wording; a scenario is a demo.
    expect(storedCwdOf({ id: "import:claude:x.jsonl", events })).toBeNull();
    expect(storedCwdOf({ id: "scenario:fanout", events })).toBeNull();
  });
});

describe("storedWorkspace: the pane for a stored session (criteria 2 and 3)", () => {
  it("names the folder the session worked in, in both languages", () => {
    const en = storedWorkspace("/work/ran-here", null, "en");
    const de = storedWorkspace("/work/ran-here", null, "de");
    expect(en).toEqual({
      kind: "pending",
      path: "/work/ran-here",
      message:
        "This chat worked in this folder. The path comes from the chat's own record; nothing on disk is read.",
    });
    expect(de).toEqual({
      kind: "pending",
      path: "/work/ran-here",
      message:
        "In diesem Ordner hat dieser Chat gearbeitet. Der Pfad stammt aus seiner eigenen Aufzeichnung, auf der Platte wird nichts gelesen.",
    });
  });

  it("reads differently from an import's recorded folder", () => {
    for (const lang of ["en", "de"] as const) {
      const stored = storedWorkspace("/work/x", null, lang);
      const imported = recordedWorkspace("/work/x", null, lang);
      expect(stored?.kind === "pending" ? stored.message : "").not.toBe(
        imported?.kind === "pending" ? imported.message : "",
      );
    }
    const en = storedWorkspace("/work/x", null, "en");
    expect(en?.kind === "pending" ? en.message.toLowerCase() : "imported").not.toContain("imported");
  });

  it("never displaces a live announcement", () => {
    expect(storedWorkspace("/work/ran-here", live, "en")).toBeNull();
  });

  it("has nothing to say without a folder", () => {
    expect(storedWorkspace(null, null, "en")).toBeNull();
    expect(storedWorkspace(undefined, null, "en")).toBeNull();
    expect(storedWorkspace("", null, "en")).toBeNull();
  });
});

describe("the Files panel of a reopened session", () => {
  it("names the folder the session ran in instead of promising a first run", () => {
    const html = filesPanel({
      storedCwd: storedCwdOf({ id: "s-421", events: [runStart({ workspace: "/work/ran-here" })] }),
    });
    expect(html).toContain("/work/ran-here");
    expect(html).toContain("This chat worked in this folder.");
    expect(html).not.toContain("no workspace yet");
  });

  it("keeps the old sentence for a session that never ran (criterion 4)", () => {
    const html = filesPanel({ storedCwd: storedCwdOf({ id: "s-421", events: [] }) });
    expect(html).toContain("no workspace yet, the first run creates it");
  });

  it("keeps an import's recorded wording (criterion 3)", () => {
    const html = filesPanel({ recordedCwd: "/work/elsewhere" });
    expect(html).toContain("/work/elsewhere");
    expect(html).toContain("recorded working folder");
    expect(html).not.toContain("This chat worked in this folder.");
  });
});

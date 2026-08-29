// Card 301: the dock's two new panels, and the tab strip that keeps exactly
// one of them mounted.
//
// Rendered with react-dom/server like the lab's other view suites (card 300's
// LabCtxDock.test.tsx is the pattern): no DOM, the canvas package stubbed,
// localStorage faked.
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

import { LabDock, dockTitleKey } from "./LabDock";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import type { RunEvent } from "../events";
import { DOCK_TABS, type DockTab } from "./labDockTabs";

const lang = currentLang();

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * Render the dock, with the character entities decoded again.
 *
 * react-dom/server escapes an apostrophe to `&#x27;`, and half the panel's
 * sentences contain one ("the run's own …"), so comparing against the string
 * the dictionary actually holds needs the markup decoded first. Decoding here
 * rather than hand-escaping every expectation keeps the assertions readable
 * and keeps the i18n dictionary the single source of the words.
 */
const dock = (tab: DockTab, applied: RunEvent[], workspaceRoot?: string | null): string =>
  renderToStaticMarkup(
    <LabDock tab={tab} onPickTab={() => {}} applied={applied} workspaceRoot={workspaceRoot} />,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const start = (agentId: string, ts: number): RunEvent =>
  ({ type: "run_start", runId: `r-${agentId}`, agentId, prompt: "go", ts }) as RunEvent;
const spawn = (agentId: string, task: string, ts: number): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task, ts }) as RunEvent;
const msg = (from: string, to: string, role: string, text: string, ts: number): RunEvent =>
  ({ type: "agent_message", from, to, role, state: "working", text, ts }) as RunEvent;
const call = (agentId: string, name: string, input: unknown, ts: number): RunEvent =>
  ({ type: "tool_call", agentId, callId: `c-${ts}`, name, input, ts }) as RunEvent;

describe("the dock shows exactly one panel", () => {
  it("offers all three tabs whichever one is open", () => {
    const html = dock("ctx", []);
    for (const key of ["lab.dock.tab.ctx", "lab.dock.tab.msg", "lab.dock.tab.files"]) {
      expect(html).toContain(t(lang, key));
    }
  });

  it("marks the open tab and only that one", () => {
    const html = dock("msg", []);
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
    expect(html).toContain(`aria-selected="true">${t(lang, "lab.dock.tab.msg")}`);
  });

  it("builds the handovers panel and NOT the other two", () => {
    const html = dock("msg", []);
    expect(html).toContain(t(lang, "lab.msg.hint"));
    expect(html).not.toContain(t(lang, "lab.ctx.hint"));
    expect(html).not.toContain(t(lang, "lab.files.hint"));
  });

  it("builds the files panel and NOT the other two", () => {
    const html = dock("files", []);
    expect(html).toContain(t(lang, "lab.files.hint"));
    expect(html).not.toContain(t(lang, "lab.ctx.hint"));
    expect(html).not.toContain(t(lang, "lab.msg.hint"));
  });

  it("keeps the context peak as the panel card 300 shipped", () => {
    const html = dock("ctx", []);
    expect(html).toContain(t(lang, "lab.ctx.hint"));
    // Embedded: the dock owns the frame, so the panel must not nest a second.
    expect(html.match(/class="lab-ctx"/g) ?? []).toHaveLength(1);
    expect(html.match(/class="lab-ctx-scroll"/g) ?? []).toHaveLength(1);
  });

  it("names the panel it is showing in its own aria-label", () => {
    expect(dock("msg", [])).toContain(`aria-label="${t(lang, "lab.msg.aria")}"`);
    expect(dock("files", [])).toContain(`aria-label="${t(lang, "lab.files.aria")}"`);
  });
});

describe("dockTitleKey — the collapsed rail names the panel it would open", () => {
  it("gives each tab its OWN title, so a shut dock never mislabels itself", () => {
    expect(dockTitleKey("ctx")).toBe("lab.ctx.title");
    expect(dockTitleKey("msg")).toBe("lab.msg.title");
    expect(dockTitleKey("files")).toBe("lab.files.title");
    // Three tabs, three distinct labels.
    expect(new Set(DOCK_TABS.map(dockTitleKey)).size).toBe(DOCK_TABS.length);
  });
});

describe("the handovers panel", () => {
  const conversation = [
    start("main", 0),
    spawn("kid", "scout the checkout", 10),
    msg("main", "kid", "task", "scout the checkout", 11),
    msg("kid", "main", "result", "found three problems", 30),
  ];

  it("says so when nothing was handed over", () => {
    expect(dock("msg", [start("main", 0)])).toContain(t(lang, "lab.msg.empty"));
  });

  it("prints the text of the handover, which nothing in the canon does", () => {
    const html = dock("msg", conversation);
    expect(html).toContain("found three problems");
    expect(html).not.toContain(t(lang, "lab.msg.empty"));
  });

  it("prints the size of each handover", () => {
    expect(dock("msg", conversation)).toContain(
      t(lang, "lab.msg.chars", { n: "found three problems".length }),
    );
  });

  it("draws the handles, never the opaque agent id", () => {
    const html = dock("msg", [
      start("main", 0),
      spawn("toolu_01opaqueid", "read the ledger", 10),
      msg("main", "toolu_01opaqueid", "task", "read the ledger", 11),
      // The child REPLYING is the case that catches a raw sender id: in a
      // parent -> child row the sender is "main", whose id and tag are the
      // same string, so that row alone cannot tell the two apart.
      msg("toolu_01opaqueid", "main", "result", "ledger read", 30),
    ]);
    expect(html).not.toContain("toolu_01opaqueid");
    expect(html).toContain(">w1<");
  });

  it("marks a direction it had to guess, and does not mark one the tree gave", () => {
    // Two agents the run never related to each other: the role word decides.
    const guessed = dock("msg", [
      start("main", 0),
      spawn("a", "ta", 5),
      spawn("b", "tb", 6),
      msg("a", "b", "task", "sideways", 20),
    ]);
    expect(guessed).toContain(t(lang, "lab.msg.guessed"));
    // The same panel over a real parent/child pair claims nothing.
    expect(dock("msg", conversation)).not.toContain(t(lang, "lab.msg.guessed"));
  });
});

describe("the files panel", () => {
  it("lists a touched path with the agent that touched it", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Write", { file_path: "src/thing.ts" }, 10),
    ]);
    expect(html).toContain("src/thing.ts");
    expect(html).toContain(t(lang, "lab.files.writtenBy"));
    // Anchored to the element boundary: "1 paths" CONTAINS "1 path", so a bare
    // substring check here is green for the plural it is meant to exclude.
    expect(html).toContain(`>${t(lang, "lab.files.countOne")}</p>`);
  });

  it("counts more than one path in the plural", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Read", { file_path: "a.ts" }, 10),
      call("main", "Read", { file_path: "b.ts" }, 20),
    ]);
    expect(html).toContain(`>${t(lang, "lab.files.count", { n: 2 })}</p>`);
    expect(html).not.toContain(`>${t(lang, "lab.files.countOne")}</p>`);
  });

  it("shortens a path against the workspace the canon knows", () => {
    const html = dock(
      "files",
      [start("main", 0), call("main", "Read", { file_path: "/w/proj/src/a.ts" }, 10)],
      "/w/proj",
    );
    expect(html).toContain(">src/a.ts<");
    // The full path stays reachable rather than being thrown away.
    expect(html).toContain('title="/w/proj/src/a.ts"');
    expect(html).toContain(t(lang, "lab.files.rootNote", { root: "proj" }));
  });

  it("shortens nothing when there is no workspace — every import and replay", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Read", { file_path: "/w/proj/src/a.ts" }, 10),
    ]);
    expect(html).toContain(">/w/proj/src/a.ts<");
  });

  // THE POINT OF THE PANEL: a quiet tree has two meanings and must say which.
  it("reads as 'this run worked through the shell', not as a broken panel", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "run_command", { command: "make build" }, 10),
      call("main", "Bash", { command: "sed -i s/a/b/ x.ts" }, 20),
    ]);
    expect(html).toContain(t(lang, "lab.files.emptyShell"));
    expect(html).not.toContain(t(lang, "lab.files.empty"));
  });

  it("says plainly when no file tool ran AND no shell ran either", () => {
    const html = dock("files", [start("main", 0)]);
    expect(html).toContain(t(lang, "lab.files.empty"));
    expect(html).not.toContain(t(lang, "lab.files.emptyShell"));
  });

  it("admits the unseen shell work beside a list that is NOT empty", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Read", { file_path: "a.ts" }, 10),
      call("main", "run_command", { command: "make" }, 20),
      call("main", "run_command", { command: "make test" }, 30),
    ]);
    expect(html).toContain("a.ts");
    expect(html).toContain(t(lang, "lab.files.shellNote", { n: 2 }));
  });

  it("counts one shell command in the singular", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Read", { file_path: "a.ts" }, 10),
      call("main", "run_command", { command: "make" }, 20),
    ]);
    expect(html).toContain(t(lang, "lab.files.shellNoteOne"));
  });

  it("marks a Glob as the search pattern it is", () => {
    const html = dock("files", [start("main", 0), call("main", "Glob", { pattern: "src/**/*.ts" }, 10)]);
    expect(html).toContain("src/**/*.ts");
    expect(html).toContain(t(lang, "lab.files.pattern"));
  });
});

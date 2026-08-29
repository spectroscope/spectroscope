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
import { LabTrace } from "./LabTrace";
import { formatTokens } from "../format";
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
const dock = (
  tab: DockTab,
  applied: RunEvent[],
  workspaceRoot?: string | null,
  onFocusEvent?: (agentId: string, event: RunEvent) => void,
): string =>
  renderToStaticMarkup(
    <LabDock
      tab={tab}
      onPickTab={() => {}}
      applied={applied}
      workspaceRoot={workspaceRoot}
      onFocusEvent={onFocusEvent}
    />,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const start = (agentId: string, ts: number): RunEvent =>
  ({ type: "run_start", runId: `r-${agentId}`, agentId, prompt: "go", ts }) as RunEvent;
const spawn = (agentId: string, task: string, ts: number): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task, ts }) as RunEvent;
const msg = (from: string, to: string, role: string, text: string, ts: number, state = "working"): RunEvent =>
  ({ type: "agent_message", from, to, role, state, text, ts }) as RunEvent;
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
    const html = dock("files", [start("main", 0), call("main", "Write", { file_path: "src/thing.ts" }, 10)]);
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

// ---------------------------------------------------------------------------
// The cross-references and the counters — the two ways this panel can state
// something false in the reader's own coordinates.
// ---------------------------------------------------------------------------

describe("the handovers panel says the same line number the trace does", () => {
  const conversation = [
    start("main", 0),
    spawn("kid", "scout the checkout", 10),
    msg("main", "kid", "task", "scout the checkout", 11),
    msg("kid", "main", "result", "found three problems", 30),
  ];

  it("names the line LabTrace labels, not the array index one short of it", () => {
    // LabTrace is the ONLY line numbering the product renders, it sits in the
    // same view as the dock, and it numbers from one. The reference is read out
    // of the trace's own markup rather than written down here, so the two
    // cannot drift apart without this going red.
    const trace = renderToStaticMarkup(<LabTrace applied={conversation} queue={[]} fireSeq={0} />);
    const seqs = [
      ...trace.matchAll(/lab-line-seq tabular">(\d+)<\/span><span class="lab-line-type mono">([a-z_]+)</g),
    ];
    const taskLine = seqs.find(([, , type], i) => type === "agent_message" && i >= 0);
    expect(taskLine, "the trace numbers the task message").toBeDefined();
    const shown = Number((taskLine as RegExpMatchArray)[1]);
    expect(shown).toBe(3);

    const html = dock("msg", conversation);
    expect(html).toContain(t(lang, "lab.msg.answers", { n: shown }));
    // The off-by-one this replaced: it named line 2, which holds the spawn.
    expect(html).not.toContain(t(lang, "lab.msg.answers", { n: shown - 1 }));
  });
});

describe("the handovers panel prints no counter it did not measure", () => {
  /** alpha spends tokens and calls tools, but nothing ever opens work for it. */
  const unfolded = [
    start("main", 0),
    { type: "usage", agentId: "alpha", inputTokens: 900, outputTokens: 400, ts: 5 } as RunEvent,
    call("alpha", "Read", { file_path: "a.ts" }, 6),
    call("alpha", "Read", { file_path: "b.ts" }, 7),
    msg("alpha", "beta", "status", "half way", 8),
  ];

  it("says the lane has no counters instead of drawing a row of zeros", () => {
    const html = dock("msg", unfolded);
    expect(html).toContain(t(lang, "lab.msg.laneNoCounts"));
    expect(html).not.toContain(t(lang, "lab.msg.laneCounts", { in: "0", out: "0", tools: 0 }));
  });

  it("draws no lifecycle chip for a lane the fold never opened", () => {
    const html = dock("msg", unfolded);
    expect(html).not.toContain("lab-msg-state");
    // …and specifically not the "handed over" it used to fabricate.
    expect(html).not.toContain(t(lang, "map.life.submitted"));
  });

  it("still prints the counters, chip and all, for a lane the fold DID open", () => {
    const html = dock("msg", [
      start("main", 0),
      spawn("kid", "scout", 10),
      msg("main", "kid", "task", "scout", 11),
      msg("kid", "main", "result", "done", 30, "completed"),
    ]);
    expect(html).toContain(t(lang, "lab.msg.laneCounts", { in: "0", out: "0", tools: 0 }));
    expect(html).not.toContain(t(lang, "lab.msg.laneNoCounts"));
  });
});

describe("the lane's lifecycle chip is a translated word, like every other one", () => {
  it("uses the SAME dictionary entry the work panel and the spectrum use", () => {
    // Anchored on the CHIP's own class, not on the bare word: a message body
    // reading "done" would make a plain substring check green for the wrong
    // reason, and this panel prints message bodies verbatim.
    const html = dock("msg", [
      start("main", 0),
      spawn("kid", "scout", 10),
      msg("main", "kid", "task", "scout", 11),
      msg("kid", "main", "result", "three problems in the ledger", 30, "completed"),
    ]);
    expect(html).toContain(
      `<span class="lab-msg-state lab-msg-state--completed">${t(lang, "map.life.completed")}</span>`,
    );
    // The raw enum was what shipped, and a German reader saw it untranslated.
    expect(html).not.toContain('lab-msg-state--completed">completed<');
  });
});

describe("a row that cannot navigate says so instead of looking clickable", () => {
  const conversation = [start("main", 0), spawn("kid", "scout", 10), msg("main", "kid", "task", "scout", 11)];
  const files = [start("main", 0), call("main", "Read", { file_path: "a.ts" }, 10)];

  /** The opening tag of the one row button with `cls`, read by MEANING rather
   *  than by attribute order (the documented attribute-order trap). */
  const rowTag = (html: string, cls: string): string => {
    const m = html.match(new RegExp(`<button[^>]*class="${cls}"[^>]*>`));
    expect(m, `a row button with class "${cls}"`).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  };

  it("disables the handover rows when no focus seam was handed in", () => {
    expect(rowTag(dock("msg", conversation), "lab-msg-open")).toContain('disabled=""');
    expect(
      rowTag(
        dock("msg", conversation, null, () => {}),
        "lab-msg-open",
      ),
    ).not.toContain("disabled");
  });

  it("does not promise 'show in the trace' on a row that cannot", () => {
    expect(dock("msg", conversation)).not.toContain(t(lang, "lab.msg.open"));
    expect(dock("msg", conversation, null, () => {})).toContain(t(lang, "lab.msg.open"));
  });

  it("disables the file rows the same way", () => {
    expect(rowTag(dock("files", files), "lab-files-open")).toContain('disabled=""');
    expect(
      rowTag(
        dock("files", files, null, () => {}),
        "lab-files-open",
      ),
    ).not.toContain("disabled");
  });
});

describe("a TRIGGERED lane prints its counters, not the sentence that denies them", () => {
  // The fold keys a triggered item by its RUN and a spawn item by its agent, so
  // a lane joined on the item id found nothing here and the panel stated, in
  // the reader's own words, that the run never opened work for this lane. It
  // had: 700 in, 250 out, one tool call, and a lifecycle it reached.
  const triggered: RunEvent[] = [
    start("main", 0),
    {
      type: "run_start",
      runId: "r-fs-4",
      agentId: "node-a",
      parentId: "main",
      prompt: "handle the dropped file",
      trigger: "fs #4 watch:/drop",
      ts: 10,
    } as RunEvent,
    { type: "usage", agentId: "node-a", inputTokens: 700, outputTokens: 250, ts: 12 } as RunEvent,
    call("node-a", "Read", { file_path: "a.ts" }, 13),
    msg("node-a", "main", "result", "handled", 20, "completed"),
  ];

  it("prints the numbers the fold counted for it", () => {
    expect(dock("msg", triggered)).toContain(
      t(lang, "lab.msg.laneCounts", {
        in: formatTokens(700),
        out: formatTokens(250),
        tools: 1,
      }),
    );
  });

  it("does not claim the run never opened work for it", () => {
    expect(dock("msg", triggered)).not.toContain(t(lang, "lab.msg.laneNoCounts"));
  });

  it("shows the lifecycle chip the fold reached", () => {
    expect(dock("msg", triggered)).toContain(
      `<span class="lab-msg-state lab-msg-state--completed">${t(lang, "map.life.completed")}</span>`,
    );
  });
});

describe("the file count counts files, and a search pattern is not one", () => {
  // The panel takes care to italicise a Glob row and to say in its tooltip that
  // a pattern names no concrete path — and then counted it into "{n} paths"
  // anyway. Two claims about the same row, in the same panel, one of them
  // wrong. The number now counts what the word says, and the patterns are
  // reported as what they are.
  const twoFilesOnePattern: RunEvent[] = [
    start("main", 0),
    call("main", "Read", { file_path: "one.ts" }, 10),
    call("main", "Read", { file_path: "two.ts" }, 11),
    call("main", "Glob", { pattern: "src/**/*.ts" }, 12),
  ];

  it("counts the files and leaves the pattern out of that number", () => {
    const html = dock("files", twoFilesOnePattern);
    expect(html).toContain(t(lang, "lab.files.count", { n: 2 }));
    expect(html).not.toContain(t(lang, "lab.files.count", { n: 3 }));
  });

  it("still lists the pattern, and says how many of the rows are patterns", () => {
    const html = dock("files", twoFilesOnePattern);
    expect(html).toContain("src/**/*.ts");
    expect(html).toContain(t(lang, "lab.files.patternsOne"));
  });

  it("counts more than one pattern in the plural", () => {
    const html = dock("files", [
      start("main", 0),
      call("main", "Read", { file_path: "one.ts" }, 10),
      call("main", "Glob", { pattern: "src/**/*.ts" }, 11),
      call("main", "Glob", { pattern: "docs/**/*.md" }, 12),
    ]);
    expect(html).toContain(t(lang, "lab.files.countOne"));
    expect(html).toContain(t(lang, "lab.files.patterns", { n: 2 }));
  });

  it("says nothing about patterns when there are none", () => {
    const html = dock("files", [start("main", 0), call("main", "Read", { file_path: "one.ts" }, 10)]);
    expect(html).toContain(t(lang, "lab.files.countOne"));
    expect(html).not.toContain(t(lang, "lab.files.patternsOne"));
  });

  it("prints no count of files at all for a run that only globbed", () => {
    // "0 paths" over a list with a row in it is the same lie from the other
    // side. The pattern line carries this run on its own.
    const html = dock("files", [start("main", 0), call("main", "Glob", { pattern: "src/**/*.ts" }, 10)]);
    expect(html).not.toContain(t(lang, "lab.files.count", { n: 0 }));
    expect(html).not.toContain(t(lang, "lab.files.countOne"));
    expect(html).toContain(t(lang, "lab.files.patternsOne"));
    expect(html).toContain("src/**/*.ts");
    // And it is NOT the empty state: the run did touch disk.
    expect(html).not.toContain(t(lang, "lab.files.empty"));
  });
});

describe("a file badge is a HANDLE, never a raw agent id", () => {
  // Card 298's rule, and the reason the directory exists: the opaque id has
  // nowhere to leak out. The badge list carried a fallback that concatenated
  // every id the directory did not hold — unreachable, because both the
  // footprint and the directory are folded from the SAME prefix and a tool_call
  // names its agent, so an agent that touched a file is always in the
  // directory. Unreachable and, if it ever had fired, the one place in this
  // panel that would have printed a raw `toolu_…` on screen.
  const opaque = "toolu_01xyzopaque";
  const touched: RunEvent[] = [
    start("main", 0),
    spawn(opaque, "read the ledger", 5),
    call(opaque, "Read", { file_path: "one.ts" }, 10),
  ];

  it("prints the handle the directory gives it", () => {
    expect(dock("files", touched)).toMatch(/class="lab-files-badge mono"[^>]*>w1</);
  });

  it("prints the opaque id nowhere at all", () => {
    expect(dock("files", touched)).not.toContain("toolu_");
  });

  it("prints one badge for one toucher, not the handle AND the id", () => {
    expect(dock("files", touched).match(/class="lab-files-badge mono"/g) ?? []).toHaveLength(1);
  });
});

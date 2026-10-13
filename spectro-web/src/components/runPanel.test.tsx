// Card 586: the compact run panel beside the chat.
//
// No DOM here: the markup comes from React's server renderer, and a press is
// the handler the panel built, run through testkit/driveComponent. The runs
// are folded from run_step lines and agent events by the fold the reducer
// uses, so the panel is tested against the shape it receives in the app.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { setLang } from "../state/lang";
import { foldRun, type RunEntry, type RunTrack } from "../state/runView";
import { drive, type El } from "../testkit/driveComponent";
import { RunHead, RunPanel } from "./RunPanel";
import { __resetRunPickForTests } from "../state/runPick";
import { RightPanel } from "./RightPanel";
import { __resetForTests, openDockPanel, openRightPanel, setDockTabs } from "../state/layout";
import { decisionText, durationText, statusMark, whoText } from "./runPanelModel";
import { NO_SELECTION } from "../testkit/noSelection";

const T0 = 1_000_000;
const R = "aaaaaaaaaaaa";
const R2 = "bbbbbbbbbbbb";

const ev = (ts: number, e: Record<string, unknown>): RunEvent => ({ ts, ...e }) as unknown as RunEvent;
const line = (runId: string, ts: number, phase: string, more: Record<string, unknown> = {}): RunEvent =>
  ev(ts, { type: "run_step", agentId: "playbook", runId, runKind: "playbook", phase, ...more });
const node = (id: string, kind = "step", entry = 1) => ({ node: id, name: nameOf(id), kind, entry });
const nameOf = (id: string): string =>
  ({ brainstorm: "Brainstorm", spec_ok: "Review", build: "Build", ship: "Ship" })[id] ?? id;

const NODES = [
  { id: "brainstorm", name: "Brainstorm", kind: "step" },
  { id: "spec_ok", name: "Review", kind: "decision" },
  { id: "build", name: "Build", kind: "step" },
  { id: "ship", name: "Ship", kind: "step" },
];

/** A playbook run: a done chat step, a done decision in round 2 of 5, a running child step. */
function runEvents(runId: string = R, t0: number = T0): RunEvent[] {
  return [
    line(runId, t0, "run_start", { name: "spectro", task: "baue Frogger", nodes: NODES }),
    line(runId, t0 + 1_000, "step_start", {
      ...node("brainstorm"),
      performer: "chat",
      provider: "ollama",
      model: "qwen2.5:7b",
      reads: [{ doc: "brief", path: "docs/brief.md" }, { doc: "house rules" }],
    }),
    ev(t0 + 1_100, {
      type: "tool_call",
      agentId: "main",
      callId: "c1",
      name: "write_file",
      input: { path: "src/a.ts", content: "x" },
    }),
    ev(t0 + 1_200, {
      type: "tool_result",
      agentId: "main",
      callId: "c1",
      output: "Wrote",
      isError: false,
      fileChange: "created",
    }),
    ev(t0 + 1_300, { type: "tool_call", agentId: "main", callId: "c2", name: "run_command", input: {} }),
    ev(t0 + 1_400, { type: "tool_call", agentId: "main", callId: "c3", name: "run_command", input: {} }),
    line(runId, t0 + 5_000, "step_end", {
      ...node("brainstorm"),
      status: "done",
      durationMs: 4_000,
      documents: [
        { doc: "spec", path: ".superpowers/spec.md", change: "created" },
        { doc: "notes", path: "notes.md", change: "changed" },
      ],
    }),
    line(runId, t0 + 6_000, "step_start", { ...node("spec_ok", "decision"), round: 2, maxRounds: 5 }),
    line(runId, t0 + 8_000, "step_end", {
      ...node("spec_ok", "decision"),
      status: "done",
      durationMs: 2_000,
      label: "changes needed",
    }),
    line(runId, t0 + 9_000, "step_start", {
      ...node("build"),
      performer: "child",
      role: "worker",
      model: "glm-5.3",
      picked: true,
    }),
    ev(t0 + 9_100, {
      type: "agent_message",
      from: "main",
      to: "worker-1",
      role: "task",
      state: "submitted",
      text: "build it",
      label: "playbook:build",
    }),
    ev(t0 + 9_200, { type: "text_delta", agentId: "worker-1", text: "compiling\nlinking the game" }),
  ];
}

const fold = (events: RunEvent[]): RunTrack[] => events.reduce(foldRun, [] as RunTrack[]);

type Calls = { jumps: RunEntry[]; paths: [string, string][]; wide: number };

function props(runs: RunTrack[], live: boolean, calls: Calls = { jumps: [], paths: [], wide: 0 }) {
  return {
    runs,
    live,
    wide: false,
    onToggleWide: () => calls.wide++,
    onJump: (entry: RunEntry) => calls.jumps.push(entry),
    onOpenPath: (run: RunTrack, path: string) => calls.paths.push([run.runId, path]),
  };
}

const html = (runs: RunTrack[], live: boolean): string =>
  renderToStaticMarkup(<RunPanel {...props(runs, live)} />);
/** The visible text of the markup, tags dropped and entities read back. */
const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

beforeEach(() => {
  __resetRunPickForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 42_000);
});
afterEach(() => {
  vi.useRealTimers();
  setLang("en");
});

describe("the run panel's header (card 586)", () => {
  it("names the run and its task, and counts the running time of a live run", () => {
    const out = text(html(fold(runEvents()), true));
    expect(out).toContain("Run: spectro");
    expect(out).toContain("baue Frogger");
    expect(out).toContain("running 0:42");
  });

  it("says no end recorded for a stored run without a run_end", () => {
    const out = text(html(fold(runEvents()), false));
    expect(out).toContain("no end recorded");
    expect(out).not.toContain("running 0:42");
  });

  it("says how long an ended run took and how it ended, from its stop reason alone", () => {
    const done = fold([
      ...runEvents(),
      line(R, T0 + 65_000, "run_end", { stopReason: "done", durationMs: 65_000 }),
    ]);
    expect(text(html(done, true))).toContain("ended after 1:05: done");
    const stopped = fold([...runEvents(), line(R, T0 + 65_000, "run_end", { stopReason: "aborted" })]);
    expect(text(html(stopped, true))).toContain("ended after 1:05: stopped");
    const failed = fold([
      ...runEvents(),
      line(R, T0 + 65_000, "run_end", { stopReason: "model_unavailable", durationMs: 65_000 }),
    ]);
    expect(text(html(failed, true))).toContain("ended after 1:05: failed");
  });

  it("says the run waits for you while it asks with no entry open", () => {
    const runs = fold([
      ...runEvents().slice(0, 9),
      ev(T0 + 8_500, { type: "question_asked", agentId: "main", callId: `pb-${R}-1`, questions: [] }),
    ]);
    expect(runs[0].waitingOn).not.toBeNull();
    const head = html(runs, true).split('class="run-strip"')[0];
    expect(text(head)).toContain("waits for you");
  });

  it("says nothing of waiting in a stored run, where nobody is asked", () => {
    const runs = fold([
      ...runEvents().slice(0, 9),
      ev(T0 + 8_500, { type: "question_asked", agentId: "main", callId: `pb-${R}-1`, questions: [] }),
    ]);
    expect(text(html(runs, false))).not.toContain("waits for you");
  });

  it("offers wide, and small while wide, and a press toggles", () => {
    const calls: Calls = { jumps: [], paths: [], wide: 0 };
    const runs = fold(runEvents());
    expect(text(renderToStaticMarkup(<RunPanel {...props(runs, true)} wide={true} />))).toContain("small");
    drive(<RunPanel {...props(runs, true, calls)} />, [RunPanel, RunHead], [(tree) => clickWide(tree)]);
    expect(calls.wide).toBe(1);
  });
});

function clickWide(tree: El[]): void {
  const wide = tree.find((el) => el.type === "button" && String(el.props.className).includes("run-wide"));
  if (wide === undefined) throw new Error("no wide button");
  expect(textOf(wide)).toBe("wide");
  wide.props.onClick?.();
}

/** The text children of an element, joined. */
function textOf(el: El): string {
  const kids = el.props.children;
  return (Array.isArray(kids) ? kids : [kids])
    .filter((k) => typeof k === "string" || typeof k === "number")
    .join("");
}

describe("the graph strip (card 586)", () => {
  it("draws one mark per node, decisions as diamonds, names in the title", () => {
    const markup = html(fold(runEvents()), true);
    const strip = markup.split('class="run-strip"')[1].split("</div>")[0];
    expect(strip).toContain('title="Brainstorm: done"');
    expect(strip).toContain("[x]");
    expect(strip).toContain('title="Review: done"');
    expect(strip).toContain("&lt;x&gt;");
    expect(strip).toContain('title="Build: running"');
    expect(strip).toContain("[&gt;]");
    expect(strip).toContain('title="Ship: not started"');
    expect(strip).toContain("[ ]");
  });
});

describe("the cards (card 586)", () => {
  it("lists one card per entry in time order, then the nodes not entered as pending", () => {
    const markup = html(fold(runEvents()), true);
    const order = [...markup.matchAll(/data-(entry|node)="([^"]+)"/g)].map((m) => m[2]);
    expect(order).toEqual([`${R}:brainstorm:1`, `${R}:spec_ok:1`, `${R}:build:1`, "ship"]);
    const ghost = markup.split('data-node="ship"')[1].split("</li>")[0];
    expect(text(ghost)).toContain("[ ]");
    expect(text(ghost)).not.toContain("skipped");
  });

  it("marks the nodes not entered as skipped once the run ended", () => {
    const runs = fold([...runEvents(), line(R, T0 + 65_000, "run_end", { stopReason: "done" })]);
    const ghost = html(runs, true).split('data-node="ship"')[1].split("</li>")[0];
    expect(text(ghost)).toContain("[~]");
    expect(text(ghost)).toContain("skipped");
  });

  it("names the chat and its model on a chat step, the helper and its role on a child step, and a picked model", () => {
    const markup = html(fold(runEvents()), true);
    const chat = card(markup, "brainstorm");
    expect(text(chat)).toContain("Chat");
    expect(text(chat)).toContain("qwen2.5:7b");
    expect(text(chat)).not.toContain("picked");
    const child = card(markup, "build");
    expect(text(child)).toContain("worker-1 (worker)");
    expect(text(child)).toContain("glm-5.3");
    expect(text(child)).toContain("picked");
  });

  it("lists what a step read under in, what it wrote under out with new or changed, its files and its shell count", () => {
    const chat = text(card(html(fold(runEvents()), true), "brainstorm"));
    expect(chat).toMatch(/in brief house rules/);
    expect(chat).toMatch(/out spec new notes changed/);
    expect(chat).toContain("src/a.ts new");
    expect(chat).toContain("2 shell commands, their files are not captured");
    expect(chat).toContain("0:04");
  });

  it("shows no shell line for a step without shell commands", () => {
    expect(text(card(html(fold(runEvents()), true), "build"))).not.toContain("shell");
  });

  it("shows the live line of the running entry and its running time", () => {
    const build = text(card(html(fold(runEvents()), true), "build"));
    expect(build).toContain("linking the game");
    expect(build).toContain("running 0:33");
  });

  it("shows no live line and no running time once the session is not live", () => {
    const build = text(card(html(fold(runEvents()), false), "build"));
    expect(build).not.toContain("linking the game");
    expect(build).toContain("no end recorded");
  });

  it("says a waiting entry waits for you", () => {
    const runs = fold([
      ...runEvents(),
      ev(T0 + 9_300, { type: "question_asked", agentId: "worker-1", callId: `pb-${R}-2`, questions: [] }),
    ]);
    expect(runs[0].entries[2].status).toBe("waiting");
    expect(text(card(html(runs, true), "build"))).toContain("waits for you");
  });

  it("gives a decision its round and its outcome", () => {
    expect(text(card(html(fold(runEvents()), true), "spec_ok"))).toContain(
      "Review, round 2 of 5: changes needed",
    );
  });

  it("shows at most five files, then how many more", () => {
    const writes: RunEvent[] = [];
    for (let i = 0; i < 7; i++) {
      writes.push(
        ev(T0 + 9_300 + i * 2, {
          type: "tool_call",
          agentId: "worker-1",
          callId: `w${i}`,
          name: "write_file",
          input: { path: `f${i}.ts` },
        }),
        ev(T0 + 9_301 + i * 2, {
          type: "tool_result",
          agentId: "worker-1",
          callId: `w${i}`,
          output: "ok",
          isError: false,
          fileChange: "created",
        }),
      );
    }
    const build = text(card(html(fold([...runEvents(), ...writes]), true), "build"));
    expect(build).toContain("f4.ts");
    expect(build).not.toContain("f5.ts");
    expect(build).toContain("+2 more");
  });
});

/** The markup of one entry's card. */
function card(markup: string, nodeId: string): string {
  const from = markup.indexOf(`data-entry="${R}:${nodeId}:1"`);
  if (from < 0) throw new Error(`no card for ${nodeId}`);
  return markup.slice(from, markup.indexOf("</article>", from));
}

describe("the presses (card 586)", () => {
  it("jumps to the entry of a pressed card, by click and by Enter", () => {
    const calls: Calls = { jumps: [], paths: [], wide: 0 };
    const runs = fold(runEvents());
    drive(
      <RunPanel {...props(runs, true, calls)} />,
      [RunPanel, RunHead],
      [
        (tree) => cardEl(tree, "spec_ok").props.onClick?.(),
        (tree) => {
          const el = cardEl(tree, "build");
          const self = {};
          const onKeyDown = el.props.onKeyDown as (e: unknown) => void;
          onKeyDown({ key: "Enter", target: self, currentTarget: self, preventDefault: () => {} });
          onKeyDown({ key: "a", target: self, currentTarget: self, preventDefault: () => {} });
          // Enter on a path button inside the card is that button's own press.
          onKeyDown({ key: "Enter", target: {}, currentTarget: self, preventDefault: () => {} });
        },
      ],
    );
    expect(calls.jumps.map((e) => e.key)).toEqual([`${R}:spec_ok:1`, `${R}:build:1`]);
  });

  it("opens a read document, a written document and a file by their paths, without jumping", () => {
    const calls: Calls = { jumps: [], paths: [], wide: 0 };
    const runs = fold(runEvents());
    let pathButtons: El[] = [];
    let stopped = 0;
    drive(
      <RunPanel {...props(runs, true, calls)} />,
      [RunPanel, RunHead],
      [
        (tree) => {
          pathButtons = tree.filter((el) => el.type === "button" && el.props.className === "run-path");
          for (const b of pathButtons)
            (b.props.onClick as (e: unknown) => void)({ stopPropagation: () => stopped++ });
        },
      ],
    );
    // The card around a path is a button too; the press stops at the path.
    expect(stopped).toBe(4);
    expect(calls.paths).toEqual([
      [R, "docs/brief.md"],
      [R, ".superpowers/spec.md"],
      [R, "notes.md"],
      [R, "src/a.ts"],
    ]);
    expect(calls.jumps).toEqual([]);
  });

  it("lists a file the step also wrote as a document once, under out", () => {
    const runs = fold([
      ...runEvents().slice(0, 6),
      ev(T0 + 1_500, {
        type: "tool_call",
        agentId: "main",
        callId: "c4",
        name: "write_file",
        input: { path: "notes.md" },
      }),
      ev(T0 + 1_600, {
        type: "tool_result",
        agentId: "main",
        callId: "c4",
        output: "ok",
        isError: false,
        fileChange: "changed",
      }),
      ...runEvents().slice(6),
    ]);
    expect(runs[0].entries[0].files.map((f) => f.path)).toEqual(["src/a.ts", "notes.md"]);
    const chat = card(html(runs, true), "brainstorm");
    expect(chat.match(/>notes\.md</g)).toBeNull();
    expect(chat.match(/title="notes\.md"/g)).toHaveLength(1);
  });

  it("shows a read without a path as its name, with nothing to open", () => {
    const chat = card(html(fold(runEvents()), true), "brainstorm");
    expect(chat).toMatch(/<span class="run-doc">house rules<\/span>/);
    expect(chat).not.toMatch(/<button[^>]*>house rules<\/button>/);
  });
});

function cardEl(tree: El[], nodeId: string): El {
  const el = tree.find((e) => e.type === "article" && e.props["data-entry"] === `${R}:${nodeId}:1`);
  if (el === undefined) throw new Error(`no card for ${nodeId}`);
  return el;
}

describe("the run picker (card 586)", () => {
  const two = (): RunTrack[] =>
    fold([
      ...runEvents(R, T0).slice(0, 7),
      line(R, T0 + 9_000, "run_end", { stopReason: "done" }),
      line(R2, T0 + 10_000, "run_start", {
        name: "second",
        nodes: [{ id: "only", name: "Only", kind: "step" }],
      }),
      line(R2, T0 + 11_000, "step_start", {
        node: "only",
        name: "Only",
        kind: "step",
        entry: 1,
        performer: "chat",
      }),
    ]);

  it("offers no picker for one run", () => {
    expect(html(fold(runEvents()), true)).not.toContain("<select");
  });

  it("lists both runs, shows the latest, and shows the other's entries when it is picked", () => {
    const runs = two();
    const markup = html(runs, true);
    expect(markup).toContain("<select");
    expect(text(markup)).toContain("1. spectro");
    expect(text(markup)).toContain("2. second");
    expect(markup).toContain(`data-entry="${R2}:only:1"`);
    expect(markup).not.toContain(`data-entry="${R}:brainstorm:1"`);
    const last = drive(
      <RunPanel {...props(runs, true)} />,
      [RunPanel, RunHead],
      [(tree) => tree.find((el) => el.type === "select")?.props.onChange?.({ target: { value: "0" } })],
    );
    const entries = last.filter((el) => el.type === "article").map((el) => el.props["data-entry"]);
    expect(entries).toEqual([`${R}:brainstorm:1`]);
  });
});

describe("the run picker follows a new run (card 586)", () => {
  it("shows a run that starts after an older one was picked", () => {
    const holder = {
      runs: fold(runEvents()).concat(fold([line(R2, T0 + 1, "run_start", { name: "second", nodes: [] })])),
    };
    function Holder(): React.JSX.Element {
      return <RunPanel {...props(holder.runs, true)} />;
    }
    const last = drive(
      <Holder />,
      [Holder, RunPanel, RunHead],
      [
        (tree) => tree.find((el) => el.type === "select")?.props.onChange?.({ target: { value: "0" } }),
        (tree) => {
          expect(tree.filter((el) => el.type === "article")).toHaveLength(3);
          holder.runs = holder.runs.concat(
            fold([line("cccccccccccc", T0 + 2, "run_start", { name: "third", nodes: [] })]),
          );
        },
      ],
    );
    const title = last.find((el) => el.type === "h3");
    expect(title === undefined ? "" : textOf(title)).toBe("Run: third");
  });
});

describe("the run panel in German (card 586)", () => {
  it("speaks German when the chrome does", () => {
    setLang("de");
    const out = text(html(fold(runEvents()), true));
    expect(out).toContain("Lauf: spectro");
    expect(out).toMatch(/rein brief house rules/);
    expect(out).toMatch(/raus spec neu notes geändert/);
    expect(out).toContain("läuft 0:42");
    expect(out).toContain("gewählt");
    expect(out).toContain("Review, Runde 2 von 5: changes needed");
  });
});

describe("the texts of a run (card 586)", () => {
  it("marks each status, decisions as diamonds", () => {
    expect(statusMark("done")).toBe("[x]");
    expect(statusMark("running")).toBe("[>]");
    expect(statusMark("waiting")).toBe("[?]");
    expect(statusMark("failed")).toBe("[!]");
    expect(statusMark("stopped")).toBe("[-]");
    expect(statusMark("pending")).toBe("[ ]");
    expect(statusMark("skipped")).toBe("[~]");
    expect(statusMark("done", true)).toBe("<x>");
    expect(statusMark("pending", true)).toBe("< >");
  });

  it("writes durations as minutes and seconds, with hours when there are any", () => {
    expect(durationText(4_000)).toBe("0:04");
    expect(durationText(134_999)).toBe("2:14");
    expect(durationText(3_723_000)).toBe("1:02:03");
    expect(durationText(0)).toBe("0:00");
    expect(durationText(-5)).toBe("0:00");
    expect(durationText(null)).toBe("");
  });

  const entry = (more: Partial<RunEntry>): RunEntry => ({ ...fold(runEvents())[0].entries[1], ...more });

  it("says limit of N rounds reached for an exhausted decision, never round 3 of 2", () => {
    const e = entry({ round: 3, maxRounds: 2, label: "exhausted" });
    expect(decisionText("en", e)).toBe("Review, limit of 2 rounds reached");
    expect(decisionText("de", e)).toBe("Review, Grenze von 2 Runden erreicht");
    expect(decisionText("en", entry({ round: 3, maxRounds: null, label: "exhausted" }))).toBe(
      "Review, round limit reached",
    );
  });

  it("writes a decision without a round or a ceiling or an outcome as far as it is known", () => {
    expect(decisionText("en", entry({ round: null, maxRounds: null, label: "ok" }))).toBe("Review: ok");
    expect(decisionText("en", entry({ round: 2, maxRounds: null, label: null }))).toBe("Review, round 2");
    expect(decisionText("en", entry({ round: 1, maxRounds: 3, label: null }))).toBe("Review, round 1 of 3");
    expect(decisionText("en", entry({ kind: "step" }))).toBeNull();
  });

  it("names who works on an entry", () => {
    const [chat, , child] = fold(runEvents())[0].entries;
    expect(whoText("en", chat)).toBe("Chat · qwen2.5:7b");
    expect(whoText("en", child)).toBe("worker-1 (worker) · glm-5.3 · picked");
    expect(whoText("de", child)).toBe("worker-1 (worker) · glm-5.3 · gewählt");
    expect(whoText("en", { ...child, agents: [], model: null, picked: false })).toBe("worker");
    expect(whoText("en", { ...child, role: null, model: null })).toBe("worker-1");
    expect(whoText("en", entry({}))).toBe("");
    expect(whoText("en", { ...child, kind: "fanout", children: ["explore-1", "explore-2"] })).toBe(
      "explore-1, explore-2 (worker) · glm-5.3 · picked",
    );
  });
});

describe("the plan panel's count with a run (card 586)", () => {
  /** The head of the plan panel in the dock, as RightPanel renders it. */
  function planHead(extra: Record<string, unknown>): string {
    __resetForTests();
    setDockTabs(false);
    openRightPanel();
    openDockPanel("plan");
    const markup = renderToStaticMarkup(
      <RightPanel
        agents={[]}
        onClose={() => {}}
        thinking
        workspace={null}
        sessionId={null}
        {...extra}
        {...NO_SELECTION}
        plans={{ main: PLAN2 }}
      />,
    );
    const from = markup.indexOf('data-panel="plan"');
    if (from < 0) throw new Error("no plan panel");
    return markup.slice(from, markup.indexOf("</header>", from));
  }
  const PLAN2 = [
    { text: "one", status: "completed" },
    { text: "two", status: "pending" },
  ];

  it("counts the plan's steps without a run, and the latest run's entries with one", () => {
    expect(planHead({})).toMatch(/tab-count tabular">2</);
    expect(planHead({ runs: fold(runEvents()) })).toMatch(/tab-count tabular">3</);
  });
});

// Card 320 — the shell station reads like a command.
//
// The owner, correcting himself: he meant the SHELL. "Der shell oben im agent
// sieht cool aus. Aber unten in der shell da ist kein syntax highlighting. Es
// wäre cool, da ein paar Sprachen zu unterstützen. Und ein schönes Format und
// ein schöner Zeilenumbruch — ein SEMANTISCHER Zeilenumbruch — wäre cool."
//
// The station renders one raw blob: `$ {command}` inside the disclosure
// (nodes.tsx, ShellBody). The tool card ONE LAYER UP already does it properly,
// through the chat renderer:
//
//     {highlight(breakShellChain(view.command), "shell")}      ToolViewBody.tsx
//
// 77% of the Bash cards in the store carry `&&` or `||`, so a five-step
// command down here has no visual edge at all — the browser wraps it at
// whatever column the card happens to be.
//
// So the value of this card is doing it the SAME way as its neighbour rather
// than a second way, and that is what this file pins: the two faces render one
// command identically, or they will drift. Nothing here re-describes the break
// rule or the token rule — both come from the functions the neighbour calls.
//
// The record keeps its own bytes everywhere it is stored, searched or
// exported. This is a display transform, and the cases below say so by holding
// the rendered text against `breakShellChain`'s own output.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpandAllContext } from "./expandContext";
import { breakShellChain } from "../../components/shellChain";
import { ToolViewBody } from "../../components/ToolViewBody";
import * as toolViews from "../../components/toolViews";
import { describeTool } from "../../components/toolViews";
import { advanceScene, initialScene, ROOT_AGENT, SHELL_COMMAND_KEY, SHELL_TOOLS } from "../labScene";
import type { RunEvent } from "../../events";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { AgentCardBody, OsNode } from "./nodes";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";
import { fleetToFlow } from "./fleetToFlow";
import { buildFleetLabScene } from "../fleetLabScene";
import type { FleetModel } from "../../spectrum/fleetModel";

const Os = OsNode as unknown as (p: { data: unknown }) => ReturnType<typeof AgentCardBody>;

/** The shell station, expanded — the disclosure only renders its body open
 *  under ExpandAll, and the compact form has no body in static markup at all
 *  (it opens on a click this gate has no DOM for). */
const shellMarkup = (
  command: string,
  tool: { name: string; input: unknown } | null = { name: "Bash", input: { command } },
) =>
  renderToStaticMarkup(
    <ExpandAllContext.Provider value={true}>
      <Os data={{ kind: "shell", active: true, command, tool, by: [], byTag: null }} />
    </ExpandAllContext.Provider>,
  );

/** Everything from the disclosure body onwards — the preview line sits before
 *  it, and the preview is a DIFFERENT claim (clipped on purpose). */
const discBody = (markup: string): string => {
  const at = markup.indexOf('class="pf-disc__body');
  expect(at, "the shell station renders no command disclosure").toBeGreaterThan(-1);
  return markup.slice(at);
};

const textOf = (html: string): string =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const shownText = (command: string): string => textOf(discBody(shellMarkup(command)));

/** The command box's own opening tag and inner markup. `highlight` emits only
 *  spans and text, so the first `</div>` after the box IS the box's closer —
 *  and if that ever stops being true the slice comes up short and the cases
 *  below go red, which is the right way round. */
const boxOf = (markup: string): { classes: string; inner: string } => {
  // Found by the scroll window only this element carries, NOT by the class
  // whose presence one of the cases below is about — a locator that keys on
  // the thing under test turns "the class is gone" into "nothing found".
  const m = /<div class="([^"]*)" style="[^"]*max-height[^"]*">/.exec(markup);
  expect(m, "the station renders no command box").not.toBeNull();
  const from = m!.index + m![0].length;
  const to = markup.indexOf("</div>", from);
  expect(to, "the command box is never closed").toBeGreaterThan(from);
  return { classes: m![1], inner: markup.slice(from, to) };
};

// The three shapes shellChain.ts exists for, plus the plain chain.
const CHAIN = "cd /tmp/spectro && ls -la && echo done";
const QUOTED = "echo 'a && b' && ls";
const HEREDOC = "cat <<'EOF' > f.txt && echo wrote\nkeep && this\nEOF";

// ---------------------------------------------------------------------------
// What the owner is looking at.
// ---------------------------------------------------------------------------
describe("the shell station renders a command, not a blob (card 320)", () => {
  it("breaks a chained command at its joints — one line per step", () => {
    const lines = shownText(CHAIN).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines).toHaveLength(breakShellChain(CHAIN).split("\n").length);
  });

  it("colours it — the command arrives as tokens, not as a string", () => {
    const body = discBody(shellMarkup(CHAIN));
    expect(body, "no highlighted span anywhere in the box").toMatch(
      /class="hl hl-(keyword|string|number|comment)"/,
    );
    expect(body).toContain('class="hl hl-keyword">cd</span>');
  });

  it("renders it exactly the way the tool card beside it renders it", () => {
    // The NEIGHBOUR ITSELF, rendered. This used to re-write the neighbour's own
    // call by hand — `highlight(breakShellChain(CHAIN), "shell")` — so both
    // sides of the comparison moved together and the tool card was free to walk
    // away from it. Measured 2026-08-30 with the hand-written case restored:
    // dropping `breakShellChain` from ToolViewBody's command region left this
    // whole file green — the drift the case is named for, invisible to it.
    const card = renderToStaticMarkup(
      <ToolViewBody
        mode="structured"
        name="Bash"
        input={{ command: CHAIN }}
        output=""
        isError={false}
        denied={false}
      />,
    );
    const region = /<div class="tv-cmd mono">([\s\S]*?)<\/div>/.exec(card);
    expect(region, "the tool card renders no command region to compare against").not.toBeNull();
    // The card prints a `$` prompt in front of its one-line region and the
    // station deliberately does not (a prompt in front of a three-step chain
    // reads as one command), so the prompt is the one part not compared.
    //
    // And the scope is a SHELL CALL, not "the two faces can never differ":
    // the card hardcodes the language (ToolViewBody.tsx:409) while the
    // station asks `blockLang`, whose first rule is a `language`/`lang`
    // field declared on the input — so a Bash call carrying
    // `language: "python"` WOULD colour the two differently. Measured
    // before writing it down rather than argued — every tool_use block in
    // ~/.claude/projects parsed and its input keys read, 2026-08-30:
    // 0 of 171,438 real Bash/run_command calls carry either field (the
    // keys that DO occur: command 171,438 · description 150,781 ·
    // timeout 16,767 · run_in_background 1,603 · four more under 100).
    // Unreachable, so the code is not widened for it and the sentence is
    // narrowed instead.
    const drawn = region![1].replace(/<span class="tv-prompt"[^>]*>\s*\$\s*<\/span>/, "");
    expect(boxOf(shellMarkup(CHAIN)).inner).toBe(drawn);
  });
});

// ---------------------------------------------------------------------------
// A break in the wrong place does not just look wrong: it shows a command that
// is not the command that ran.
// ---------------------------------------------------------------------------
describe("the record keeps its bytes (card 320)", () => {
  it("an && inside single quotes is not a joint", () => {
    const shown = shownText(QUOTED);
    expect(shown).toContain(breakShellChain(QUOTED));
    expect(shown.split("\n")).toHaveLength(breakShellChain(QUOTED).split("\n").length);
  });

  it("an && inside a heredoc body is not a joint", () => {
    const shown = shownText(HEREDOC);
    expect(shown).toContain(breakShellChain(HEREDOC));
    expect(shown.split("\n")).toHaveLength(breakShellChain(HEREDOC).split("\n").length);
  });

  it("a command longer than the reserve is never truncated into a lie", () => {
    const long = Array.from({ length: 40 }, (_, i) => `step${i} --flag=${i}`).join(" && ");
    const shown = shownText(long);
    expect(shown).toContain(breakShellChain(long));
    expect(shown, "the full text is clipped with an ellipsis").not.toContain("…");
  });

  // `toContain` was all three cases above had, and containment is not what the
  // card claims. Measured 2026-08-30: putting the old `$ ` prompt back in front
  // of the block left the fifteen cases this file then had all green, while
  // nodes.tsx says in its own comment that there is no `$` in there any more —
  // one prompt in front of a three-step chain reads as one command. So the box
  // is held to the bytes.
  it("and the box holds those bytes and nothing else", () => {
    for (const command of [CHAIN, QUOTED, HEREDOC]) {
      expect(textOf(boxOf(shellMarkup(command)).inner), command).toBe(breakShellChain(command));
    }
  });
});

// ---------------------------------------------------------------------------
// The two things that must NOT change while this lands.
// ---------------------------------------------------------------------------
describe("the box and the preview line still behave (card 320)", () => {
  // `breakShellChain` puts \n into a TEXT NODE, and a text node's newlines
  // collapse to spaces under the browser default. So one CSS class carries the
  // whole deliverable, and every case in this file reads the break out of the
  // markup, where it is there either way. Measured 2026-08-30: dropping
  // `pf-shell__box` from the box left the fifteen cases this file then had and
  // nodeCards.test.tsx's fourteen all green, with the owner back in front of
  // the blob.
  //
  // Both halves are read, neither typed: the classes off the rendered box, the
  // rule out of flowmap.css.
  it("the box wears a class that KEEPS the newlines it renders", () => {
    const css = readFileSync(new URL("./flowmap.css", import.meta.url).pathname, "utf8");
    const { classes } = boxOf(shellMarkup(CHAIN));
    const keeps = classes.split(/\s+/).filter((c) => {
      const at = css.indexOf(`.${c} {`);
      return at > -1 && /white-space:\s*pre(-wrap|-line)?\s*;/.test(css.slice(at, css.indexOf("}", at)));
    });
    expect(keeps, `none of "${classes}" keeps the line breaks — they collapse to spaces`).not.toEqual([]);
  });

  it("the box still scrolls in its own container, and the wheel stays off the canvas", () => {
    const body = discBody(shellMarkup(CHAIN));
    expect(body).toContain("nowheel");
    expect(body).toMatch(/overflow:\s*auto/);
    expect(body).toMatch(/max-height:\s*240px/);
  });

  it("the one-line preview still clips, and still marks the clip", () => {
    const long = `cd ${"/a/very/long/path".repeat(4)} && ls`;
    const markup = shellMarkup(long);
    const head = markup.slice(0, markup.indexOf('class="pf-disc'));
    expect(head).toContain("pf-shell__cmd");
    expect(head, "the preview line stopped clipping").toContain("…");
    expect(head).not.toContain(long);
  });
});

// ---------------------------------------------------------------------------
// The wider question the owner asked: the station carries the command of
// whatever tool is running, so WHAT picks the language?
// ---------------------------------------------------------------------------
const NODES_SRC = readFileSync(new URL("./nodes.tsx", import.meta.url).pathname, "utf8");

const sourceBlock = (src: string, opener: string, closer: string): string => {
  const at = src.indexOf(opener);
  expect(at, opener).toBeGreaterThan(-1);
  const end = src.indexOf(closer, at);
  expect(end, closer).toBeGreaterThan(at);
  return src.slice(at, end + closer.length);
};

const SHELL_BODY = sourceBlock(NODES_SRC, "function ShellBody(", "\n}");

/** The classifier, read off the module rather than imported by name, so a
 *  toolViews.ts that has not exported it yet fails a CASE with its own message
 *  instead of killing the whole file at link time. */
const blockLangOf = (name: string, input: unknown): string | null => {
  const fn = (toolViews as unknown as { blockLang?: (n: string, k: string, i: unknown) => string | null })
    .blockLang;
  expect(fn, "toolViews.ts exports no blockLang — the station has no classifier to ask").toBeTypeOf(
    "function",
  );
  return fn!(name, SHELL_COMMAND_KEY, input);
};

describe("the language is asked, not asserted (card 320)", () => {
  it("ShellBody spells no language out", () => {
    // Scoped to ShellBody on purpose. The language DOES appear elsewhere in
    // nodes.tsx — `case "shell":` is the STATION's own kind and it stays; a
    // file-wide ban would be a claim about the wrong thing.
    //
    // The banned word is the classifier's OWN answer, not a literal typed here,
    // and every quoting form is banned. `not.toContain('"shell"')` was the
    // guard, and measured 2026-08-30 the naive fix in BACKTICKS walked past it
    // and past eslint and prettier as well.
    const answer = blockLangOf("Bash", { command: "ls -la" });
    expect(answer, "the classifier answers nothing for a shell call").not.toBeNull();
    expect(SHELL_BODY, `ShellBody spells "${answer}" out instead of asking`).not.toMatch(
      new RegExp(`["'\`]${answer}["'\`]`),
    );
  });

  it("ShellBody asks the classifier instead", () => {
    expect(SHELL_BODY, "the station names no classifier").toContain("blockLang(");
  });

  it("the classifier is reachable, and it answers for a command field", () => {
    // Read off the module rather than imported by name, so a toolViews.ts that
    // has not exported it yet fails THIS case with its own message instead of
    // killing the whole file at link time.
    const blockLang = (
      toolViews as unknown as { blockLang?: (n: string, k: string, i: unknown) => string | null }
    ).blockLang;
    expect(blockLang, "toolViews.ts exports no blockLang — the station has no classifier to ask").toBeTypeOf(
      "function",
    );
    expect(blockLang!("Bash", "command", { command: "ls -la" })).toBe("shell");
  });

  // Why "shell" is the right answer TODAY, held against the source rather than
  // remembered: `activeCommand` is written in exactly one place (labScene.ts,
  // the tool_call arm) and only for the members of SHELL_TOOLS. A name added
  // to that set whose call is not a command must break this.
  it("every tool that reaches this station carries a shell command", () => {
    expect(SHELL_TOOLS.size).toBeGreaterThanOrEqual(2);
    for (const name of SHELL_TOOLS) {
      expect(describeTool(name, { command: "x" }, undefined, false).kind, name).toBe("command");
    }
  });
});

// ---------------------------------------------------------------------------
// The wiring. A station that classifies correctly in a test and is handed
// nothing to classify in the app is the same blob the owner is looking at —
// `sceneToFlow` gives os-mcp its call and os-shell none.
// ---------------------------------------------------------------------------
const T = 1700000000000;

const shellNodeData = (name: string, input: unknown) => {
  const events: RunEvent[] = [
    {
      type: "run_start",
      runId: "r1",
      agentId: ROOT_AGENT,
      prompt: "hi",
      provider: "anthropic",
      ts: T,
    } as RunEvent,
    { type: "tool_call", agentId: ROOT_AGENT, callId: "c1", name, input, ts: T } as RunEvent,
  ];
  const scene = events.reduce(advanceScene, initialScene());
  const flow = sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "m" });
  const node = flow.nodes.find((n) => n.id === "os-shell");
  expect(node, "os-shell").toBeDefined();
  return node!.data as { command?: string | null; tool?: { name: string; input: unknown } | null };
};

describe("the station is handed the call it is drawing (card 320)", () => {
  it("os-shell carries the tool, not only its command string", () => {
    const data = shellNodeData("Bash", { command: "ls -la" });
    expect(data.command).toBe("ls -la");
    expect(
      data.tool,
      "the shell node carries no call — there is nothing to ask the classifier about",
    ).toEqual({
      name: "Bash",
      input: { command: "ls -la" },
    });
  });

  // What this pins is that the station empties with the packet. It does NOT
  // pin the occupant guard, and an earlier version of this comment claimed it
  // did — measured wrong, and left standing forty lines above its own
  // correction. `deriveDetail` drops a call on its tool_result (sceneToFlow.ts,
  // `d.tool[e.agentId] = undefined`), so a finished command cannot linger here
  // whatever the station is wired to. The leak that CAN happen is the case
  // below, and that is where the guard is bitten.
  it("and carries none once the call has finished", () => {
    const events: RunEvent[] = [
      {
        type: "run_start",
        runId: "r1",
        agentId: ROOT_AGENT,
        prompt: "hi",
        provider: "anthropic",
        ts: T,
      } as RunEvent,
      {
        type: "tool_call",
        agentId: ROOT_AGENT,
        callId: "c1",
        name: "Bash",
        input: { command: "ls -la" },
        ts: T,
      } as RunEvent,
      {
        type: "tool_result",
        agentId: ROOT_AGENT,
        callId: "c1",
        output: "a\nb",
        isError: false,
        durationMs: 3,
        ts: T + 3,
      } as RunEvent,
    ];
    const scene = events.reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "m" });
    const data = flow.nodes.find((n) => n.id === "os-shell")!.data as { active?: boolean; tool?: unknown };
    expect(data.active).toBe(false);
    expect(data.tool ?? null, "a finished call is still on the station").toBeNull();
  });

  // ADDED while making this file green. The case above passes with the station
  // wired to the agent's current call OUTRIGHT — measured — because
  // `deriveDetail` drops a call on its own tool_result, so the leak its comment
  // describes cannot happen. The leak that CAN is a call standing somewhere
  // else: a Read in flight is the agent's current call and belongs to the disk.
  // Unguarded, this station carries it while the disk beside it is the one
  // spinning, and the classifier is then asked about a tool that never came
  // here. That is what the occupant test in sceneToFlow actually buys, so it is
  // bitten here rather than only asserted there.
  it("and never a call that is standing at another station", () => {
    const data = shellNodeData("Read", { file_path: "/a/b.ts" });
    expect(data.command ?? null, "a disk call left a command here").toBeNull();
    expect(data.tool ?? null, "a disk call is standing on the shell station").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `os-shell` is built in TWO places, and only one of them was taught. The lab
// map's builder hands the station its call; the fleet machine room's does not,
// although `os-mcp` two entries further down the SAME array does. `ShellBody`
// then asks the classifier about nothing, gets null, and `highlight` returns
// the string untouched: on a shipped surface (FleetLab) the chain still breaks
// and the colour is simply absent — half of this card.
//
// Nothing here decides WHICH producers exist. They are found by asking the
// flow builders for the station, so a third builder is covered the day it is
// written, and a builder that stops emitting the station is red.
// ---------------------------------------------------------------------------
const CMD = "cd /tmp/spectro && ls -la && echo done";

const runOf = (name: string, input: unknown): RunEvent[] => [
  {
    type: "run_start",
    runId: "r1",
    agentId: ROOT_AGENT,
    prompt: "hi",
    provider: "anthropic",
    ts: T,
  } as RunEvent,
  { type: "tool_call", agentId: ROOT_AGENT, callId: "c1", name, input, ts: T } as RunEvent,
];

const labShell = (name = "Bash", input: unknown = { command: CMD }): Record<string, unknown> => {
  const events = runOf(name, input);
  const scene = events.reduce(advanceScene, initialScene());
  const flow = sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "m" });
  return flow.nodes.find((n) => n.id === "os-shell")!.data as Record<string, unknown>;
};

const fleetShell = (name = "Bash", input: unknown = { command: CMD }): Record<string, unknown> => {
  const events = runOf(name, input);
  const model: FleetModel = {
    roster: [
      { id: ROOT_AGENT, role: "root", capabilities: [], topic: "ctx.events", connected: true, lastSeen: T },
    ],
    events,
    frames: [],
    epochBySender: {},
  };
  const flow = fleetToFlow(buildFleetLabScene(model), deriveDetail(events), { lang: "en" });
  const node = flow.nodes.find((n) => n.id === "os-shell");
  expect(node, "the fleet machine room has no shell station").toBeDefined();
  return node!.data as Record<string, unknown>;
};

describe("both producers of this station draw the same command (card 320)", () => {
  const producers: [string, (n?: string, i?: unknown) => Record<string, unknown>][] = [
    ["the lab map", labShell],
    ["the fleet machine room", fleetShell],
  ];

  it("each one hands the station the call it is drawing", () => {
    for (const [where, produce] of producers) {
      const data = produce();
      expect(data.command, where).toBe(CMD);
      expect(data.tool ?? null, `${where}: the station has nothing to ask the classifier about`).toEqual({
        name: "Bash",
        input: { command: CMD },
      });
    }
  });

  it("so the box reads the same on both, coloured and broken at its joints", () => {
    const drawn = producers.map(([where, produce]) => {
      const markup = renderToStaticMarkup(
        <ExpandAllContext.Provider value={true}>
          <Os data={produce()} />
        </ExpandAllContext.Provider>,
      );
      const box = boxOf(markup).inner;
      expect(box, `${where}: the command is not coloured — the station was handed no call`).toContain(
        'class="hl hl-keyword"',
      );
      expect(textOf(box), where).toBe(breakShellChain(CMD));
      return box;
    });
    expect(drawn[0], "the two faces of one station drew one command differently").toBe(drawn[1]);
  });

  it("and neither hands it a call that is standing at another station", () => {
    for (const [where, produce] of producers) {
      const data = produce("Read", { file_path: "/a/b.ts" });
      expect(data.command ?? null, `${where}: a disk call left a command here`).toBeNull();
      expect(data.tool ?? null, `${where}: a disk call is standing on the shell station`).toBeNull();
    }
  });
});

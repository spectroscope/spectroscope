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
import { highlight } from "../../components/Highlighted";
import * as toolViews from "../../components/toolViews";
import { describeTool } from "../../components/toolViews";
import { advanceScene, initialScene, ROOT_AGENT, SHELL_TOOLS } from "../labScene";
import type { RunEvent } from "../../events";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { AgentCardBody, OsNode } from "./nodes";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";

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
    // Not "it calls highlight" — the produced structure, so the two faces
    // cannot drift into two ways of drawing one command.
    const neighbour = renderToStaticMarkup(<>{highlight(breakShellChain(CHAIN), "shell")}</>);
    expect(discBody(shellMarkup(CHAIN))).toContain(neighbour);
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

  it("a command longer than the reserve is scrolled, never truncated into a lie", () => {
    const long = Array.from({ length: 40 }, (_, i) => `step${i} --flag=${i}`).join(" && ");
    const shown = shownText(long);
    expect(shown).toContain(breakShellChain(long));
    expect(shown, "the full text is clipped with an ellipsis").not.toContain("…");
  });
});

// ---------------------------------------------------------------------------
// The two things that must NOT change while this lands.
// ---------------------------------------------------------------------------
describe("the box and the preview line still behave (card 320)", () => {
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

describe("the language is asked, not asserted (card 320)", () => {
  it("ShellBody spells no language out", () => {
    // Scoped to ShellBody on purpose. `"shell"` DOES appear elsewhere in
    // nodes.tsx — `case "shell":` is the STATION's own kind and it stays; a
    // file-wide ban would be a claim about the wrong thing.
    expect(SHELL_BODY).not.toContain('"shell"');
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

  // The leak this guards is a real one: `deriveDetail` keeps the LAST call per
  // agent, so a station wired as `tool: detail.tool[agent]` outright would go
  // on drawing a finished command after the packet has left. os-mcp asks
  // whether its occupant is there first; os-shell has to as well.
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
});

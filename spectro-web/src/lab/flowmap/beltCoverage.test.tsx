// Card 321 — the belt lights the tool that is ACTUALLY running.
//
// The owner, looking at his own imported session: the chips up top were put
// there to say "THIS tool is running right now". They never say it. A Bash
// call lights nothing while the panel beside it reads TOOL CALL · BASH, and a
// Workflow lights Workflow only because the two spellings happen to be equal.
//
// Measured over ~/.claude/projects on 2026-08-30 (6.2 GB, 106 folders):
// 292,465 `tool_use` blocks, 135 distinct names. Exactly 794 of them — 0.27% —
// light a chip today: 683 Workflow and 111 Monitor. ZERO occurrences of any of
// the seven names TOOL_CHIPS lists, because `agentBelt` compares the wire name
// to its own labels with `===` and an imported Claude Code transcript spells
// none of them.
//
// ── THE TRAP THIS FILE EXISTS TO CLOSE ──────────────────────────────────────
// The obvious repair is a second hand list — `Bash → run_command`,
// `Read → read_file` — and the next transcript carrying a name nobody typed
// goes dark again, silently, exactly as it does today. This house has been
// bitten by a hand list guarded by a test that types the same hand list three
// times in one card. So NOTHING below types a tool name that is not this
// belt's OWN chip label:
//
//   - every name in the coverage cases is read out of `describeTool`'s own
//     `case "…":` labels in toolViews.ts (card 314's sourceBlock technique);
//   - every name in the station cases is read out of the sets labScene
//     exports (DISK_TOOLS, CC_DISK_READ, CC_DISK_WRITE, SHELL_TOOLS).
//
// THE BITE that proves it: plant `case "ReadFile":` beside `Read` in
// toolViews.ts and run this file. Nothing else edited, the name typed in
// exactly one place — the group case below then demands that `ReadFile` light
// `read_file`, and it is green under a describeTool-routed belt and RED under
// any hand list. Remove the plant, `git diff toolViews.ts` empty.
//
// The four names typed in the "reported, not dark" cases below are census
// EXEMPLARS, not a mapping: they stand for the 18,300 blocks (6.3%) whose view
// kind answers to no chip at all, and nothing is derived from them.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as beltModule from "./belt";
import { describeTool } from "../../components/toolViews";
import { dict } from "../../i18n/i18n";
import {
  advanceScene,
  initialScene,
  CC_DISK_READ,
  CC_DISK_WRITE,
  DISK_TOOLS,
  ROOT_AGENT,
  SHELL_TOOLS,
  type Focus,
} from "../labScene";
import type { RunEvent } from "../../events";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { AgentCardBody, type AgentData } from "./nodes";

const { agentBelt, TOOL_CHIPS, LAUNCH_CHIPS } = beltModule;

const litChips = (activeTool: string | null) => agentBelt(activeTool).filter((c) => c.on);
const lit = (activeTool: string | null): string[] => litChips(activeTool).map((c) => c.name);
/** The lit chip's kind, widened to a string so a THIRD kind can be asserted
 *  before the union declares it — and read off the belt rather than typed, so
 *  this file never decides what that third kind is called. */
const litKind = (activeTool: string | null): string =>
  String(litChips(activeTool)[0]?.kind ?? "«nothing lit»");

// ---------------------------------------------------------------------------
// The two sources of truth, read as text. Neither is copied into this file.
// ---------------------------------------------------------------------------
const TOOL_VIEWS = readFileSync(new URL("../../components/toolViews.ts", import.meta.url).pathname, "utf8");
const BELT_SRC = readFileSync(new URL("./belt.ts", import.meta.url).pathname, "utf8");

/**
 * belt.ts with its prose removed — what is left is what runs.
 *
 * Both obvious forms of this search are wrong. Searching the WHOLE text flags
 * belt.ts's own header, which is English and uses several of these words. And
 * searching only the QUOTED form is what this case did first — measured on
 * 2026-08-30, planting `{ Bash: "run_command", Read: "read_file" }` into
 * belt.ts left the case GREEN, because a bare object key carries no quotes.
 * A guard that a hand list walks past is the thing it was written to stop.
 */
const BELT_CODE = BELT_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** One top-level declaration, verbatim. Nested closers are indented, so a
 *  closer at column 0 is this block's own (card 314). */
const sourceBlock = (src: string, opener: string, closer: string): string => {
  const at = src.indexOf(opener);
  expect(at, opener).toBeGreaterThan(-1);
  const end = src.indexOf(closer, at);
  expect(end, closer).toBeGreaterThan(at);
  return src.slice(at, end + closer.length);
};

const DESCRIBE_TOOL = sourceBlock(TOOL_VIEWS, "export function describeTool(", "\n}");

/**
 * Every `case "…":` run in describeTool, grouped by the body it shares.
 *
 * A group ends at the label that OPENS the body (`case "view_file": {`), so
 * the three spellings of a read arrive together and the reader of this file
 * never has to know which they are.
 */
const caseGroups = (): string[][] => {
  const groups: string[][] = [];
  let open: string[] = [];
  for (const line of DESCRIBE_TOOL.split("\n")) {
    const m = /^\s*case "([^"]+)":/.exec(line);
    if (m === null) continue;
    open.push(m[1]);
    if (line.trimEnd().endsWith("{")) {
      groups.push(open);
      open = [];
    }
  }
  expect(open, "a case run with no body — this parse is wrong, not the source").toEqual([]);
  return groups;
};

const GROUPS = caseGroups();
const CASE_NAMES = GROUPS.flat();

// Floors, not coverage lists. A parse that stops matching would otherwise turn
// every case below into a green scan over nothing.
//   grep -c 'case "' src/components/toolViews.ts   → 41 on 2026-08-30
const NAME_FLOOR = 40;
const GROUP_FLOOR = 15;

describe("the names this file works from come out of the source", () => {
  it("reads describeTool's own case labels, and finds them all", () => {
    expect(CASE_NAMES.length).toBeGreaterThanOrEqual(NAME_FLOOR);
    expect(GROUPS.length).toBeGreaterThanOrEqual(GROUP_FLOOR);
    expect(new Set(CASE_NAMES).size, "a name declared twice").toBe(CASE_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// The three the owner is actually looking at. One bite each — two cases that
// fall with one message are one case.
// ---------------------------------------------------------------------------
describe("the belt lights the tool that is running (card 321)", () => {
  it("a Bash call lights the command chip", () => {
    expect(lit("Bash")).toEqual(["run_command"]);
  });

  it("a Read call lights the read chip", () => {
    expect(lit("Read")).toEqual(["read_file"]);
  });

  it("an mcp__ call lights the MCP chip", () => {
    expect(lit("mcp__Claude_Browser__navigate")).toEqual(["call_mcp"]);
  });

  it("the harness's own names still light exactly what they always did", () => {
    for (const name of TOOL_CHIPS) {
      expect(lit(name), name).toEqual([name]);
      expect(litKind(name), name).toBe("tool");
    }
  });

  it("a launch still draws as a launch", () => {
    for (const name of LAUNCH_CHIPS) {
      expect(lit(name), name).toEqual([name]);
      expect(litKind(name), name).toBe("launch");
    }
  });
});

// ---------------------------------------------------------------------------
// The honesty half. 18,300 of the 292,465 blocks (6.3%) resolve to no chip:
// web 7,716 · generic 6,690 · task 2,664 · agents 947 · question 278 ·
// matches 5. Today every one of them reads as "nothing is running", which is
// the defect — the belt would rather say nothing than say it does not know.
// ---------------------------------------------------------------------------
describe("a tool with no chip is REPORTED, not silently dark", () => {
  it("WebFetch is named on the belt while it runs", () => {
    const on = litChips("WebFetch");
    expect(
      on.map((c) => c.name),
      "the running tool is nowhere on the belt",
    ).toEqual(["WebFetch"]);
  });

  it("and it draws as neither a tool of this belt nor a launch", () => {
    expect(TOOL_CHIPS).not.toContain("WebFetch");
    expect(LAUNCH_CHIPS).not.toContain("WebFetch");
    // The chip has to EXIST before its kind is worth judging. Asserting only
    // "not tool, not launch" is green while nothing is lit at all, which is
    // the very defect — a test green in both directions pins nothing.
    const on = litChips("WebFetch");
    expect(on, "nothing is lit, so there is no kind to judge").toHaveLength(1);
    expect(["tool", "launch"]).not.toContain(String(on[0].kind));
  });

  it("the other unmapped names of the census are named too, and all as one kind", () => {
    // StructuredOutput 4,066 · ToolSearch 1,883 · TaskUpdate · Task. Exemplars,
    // not a mapping — nothing is derived from these four.
    const kinds = new Set<string>();
    for (const name of ["StructuredOutput", "ToolSearch", "TaskUpdate", "Task"]) {
      expect(lit(name), name).toEqual([name]);
      kinds.add(litKind(name));
    }
    expect([...kinds], "one third kind, not a kind per tool").toHaveLength(1);
    expect(["tool", "launch"]).not.toContain([...kinds][0]);
  });

  it("between calls nothing is lit, and no name chip stands", () => {
    expect(litChips(null)).toEqual([]);
    expect(agentBelt(null).map((c) => c.name)).toEqual([...TOOL_CHIPS, ...LAUNCH_CHIPS]);
  });
});

// ---------------------------------------------------------------------------
// THE DERIVATIONS. Nothing here types a tool name.
// ---------------------------------------------------------------------------
describe("the coverage is derived from describeTool, not listed (card 321)", () => {
  it("every name describeTool answers to lights exactly one chip", () => {
    for (const name of CASE_NAMES) expect(lit(name), name).toHaveLength(1);
    expect(litChips(null), "and none between calls").toEqual([]);
  });

  it("names that share one describeTool case share one chip", () => {
    for (const group of GROUPS) {
      // A launch is asked FIRST and on purpose: `Monitor` sits inside the Bash
      // case and still has to draw as a launch (belt.ts, and the case below).
      const names = group.filter((n) => !LAUNCH_CHIPS.includes(n));
      if (names.length < 2) continue;
      const label = group.join(" / ");
      const kinds = new Set(names.map(litKind));
      expect([...kinds], label).toHaveLength(1);
      if ([...kinds][0] === "tool") {
        expect([...new Set(names.map((n) => lit(n)[0]))], label).toHaveLength(1);
      }
    }
  });

  // THE FOURTH-ELEMENT BITE lives here. Plant `case "ReadFile":` beside `Read`
  // in toolViews.ts — one place, nothing else edited — and this case demands
  // that `ReadFile` light `read_file`, because `read_file` is one of the names
  // sharing that case and it is a chip of this belt. Green through
  // describeTool, RED through any hand list.
  it("a case that carries one of this belt's own labels lights THAT chip for all of them", () => {
    let covered = 0;
    for (const group of GROUPS) {
      const own = group.find((n) => TOOL_CHIPS.includes(n));
      if (own === undefined) continue;
      for (const name of group) {
        if (LAUNCH_CHIPS.includes(name)) continue;
        expect(lit(name), `${name} shares ${own}'s case`).toEqual([own]);
        covered++;
      }
    }
    // A floor, so a broken `find` cannot turn the loop above into a scan over
    // nothing: Read/read_file/view_file, Write/create_file/write_file,
    // list_dir, Bash/run_in_terminal/run_command, generate_image,
    // Skill/use_skill — 13 names in 6 cases on 2026-08-30.
    expect(covered).toBeGreaterThanOrEqual(12);
  });

  it("belt.ts spells no vocabulary but its own chip labels", () => {
    const own = new Set([...TOOL_CHIPS, ...LAUNCH_CHIPS]);
    for (const name of CASE_NAMES) {
      if (own.has(name)) continue;
      expect(new RegExp(`\\b${name}\\b`).test(BELT_CODE), `belt.ts names ${name} in its code`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The kind table. A new arm on ToolView must be a compile error, not a chip
// that quietly goes dark — so the table is a Record over the whole union, and
// this reads the union out of its own declaration to say so.
// ---------------------------------------------------------------------------
const VIEW_UNION = sourceBlock(TOOL_VIEWS, "export type ToolView =", "\n\n");
const VIEW_KINDS = [...new Set([...VIEW_UNION.matchAll(/kind: "([a-z]+)"/g)].map((m) => m[1]))];

describe("the kind→chip table is exhaustive over the view kinds", () => {
  it("reads every kind out of the ToolView union", () => {
    // 16 on 2026-08-30:
    //   sed -n '/^export type ToolView =/,/^$/p' src/components/toolViews.ts | grep -c 'kind: "'
    expect(VIEW_KINDS.length).toBeGreaterThanOrEqual(15);
  });

  it("the belt declares a chip — or an honest null — for every one of them", () => {
    // Read off the module rather than imported by name: a belt that does not
    // export the table yet fails THIS case with its own message instead of
    // killing the whole file at link time.
    const table = (beltModule as unknown as { CHIP_FOR_KIND?: Record<string, string | null> }).CHIP_FOR_KIND;
    expect(table, "belt.ts exports no CHIP_FOR_KIND — the kind→chip table this card asks for").toBeDefined();
    expect(Object.keys(table!).sort()).toEqual([...VIEW_KINDS].sort());
  });

  it("and every chip it names is a chip this belt actually draws", () => {
    const table = (beltModule as unknown as { CHIP_FOR_KIND?: Record<string, string | null> }).CHIP_FOR_KIND;
    expect(table, "belt.ts exports no CHIP_FOR_KIND").toBeDefined();
    for (const [kind, chip] of Object.entries(table!)) {
      if (chip !== null) expect(TOOL_CHIPS, kind).toContain(chip);
    }
  });
});

// ---------------------------------------------------------------------------
// The second derivation: the belt and the stations. This is what carries
// `MultiEdit`, which sits in CC_DISK_WRITE and has no case in describeTool at
// all (zero calls in the census — latent, not theoretical).
// ---------------------------------------------------------------------------
const station = (name: string): Focus =>
  advanceScene(initialScene(), {
    type: "tool_call",
    agentId: ROOT_AGENT,
    callId: "c1",
    name,
    input: {},
    ts: 0,
  } as RunEvent).focus;

/** Which chips belong to which station. A mapping of STATIONS — four of them,
 *  fixed by the map's own geometry — and deliberately not of tool names: every
 *  name below is read out of the sets labScene exports, so a fourth name added
 *  to CC_DISK_WRITE must go red until the belt covers it. */
const STATION_CHIPS: Partial<Record<Focus, string[]>> = {
  cmd: ["run_command"],
  disk: ["read_file", "write_file", "list_dir"],
  mcp: ["call_mcp"],
};

describe("the belt and the station agree about where a call goes (card 321)", () => {
  it("every name the fold routes to a station lights a chip of that station", () => {
    const routed = [...DISK_TOOLS, ...CC_DISK_READ, ...CC_DISK_WRITE, ...SHELL_TOOLS];
    // Floor: 3 + 2 + 3 + 2 on 2026-08-30 (labScene.ts).
    expect(routed.length).toBeGreaterThanOrEqual(10);
    for (const name of routed) {
      const where = station(name);
      const allowed = STATION_CHIPS[where];
      expect(allowed, `${name} is routed to the "${where}" station, which has no chips`).toBeDefined();
      expect(lit(name), name).toHaveLength(1);
      expect(allowed, `${name} lights ${lit(name)[0]}, which is not a "${where}" chip`).toContain(
        lit(name)[0],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The one place describeTool alone gives the wrong answer, and the reason the
// launch names are asked first.
// ---------------------------------------------------------------------------
describe("Monitor keeps its launch chip (card 321)", () => {
  it("draws as a launch although describeTool calls it a command", () => {
    expect(
      describeTool("Monitor", { command: "until grep -q done f; do sleep 5; done" }, undefined, false).kind,
    ).toBe("command");
    expect(lit("Monitor")).toEqual(["Monitor"]);
    expect(litKind("Monitor")).toBe("launch");
    expect(lit("Monitor")).not.toContain("run_command");
  });
});

// ---------------------------------------------------------------------------
// The chip reaches the card. A belt that knows and a render that does not draw
// it is the same darkness the owner is looking at.
// ---------------------------------------------------------------------------
const agentData = (activeTool: string, input: unknown): AgentData => ({
  active: true,
  error: false,
  focus: "agent",
  activity: { text: "working", color: "var(--sand)" },
  gate: "none",
  gateNote: "ready",
  gateColor: "var(--border-strong)",
  activeTool,
  ctxParts: null,
  ctxTotals: null,
  prompt: "go",
  systemPrompt: null,
  tool: { name: activeTool, input },
  genImage: null,
  attached: null,
});

/** The attributes of the one element whose whole text is `name`. */
const chipTag = (markup: string, name: string): string => {
  const m = new RegExp(`<span [^>]*>${name}</span>`).exec(markup);
  expect(m, `the belt draws no chip printing "${name}"`).not.toBeNull();
  return m![0];
};

const unescape = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("the unmapped chip reaches the card (card 321)", () => {
  const markup = () =>
    renderToStaticMarkup(<AgentCardBody data={agentData("WebFetch", { url: "https://x" })} />);

  it("prints the running tool's own wire name, lit, in its own kind's clothes", () => {
    const tag = chipTag(markup(), "WebFetch");
    expect(tag).toContain(`pf-chip--${litKind("WebFetch")}`);
    expect(tag).toContain("pf-chip--on");
  });

  it("and says WHY it has no station, in both languages", () => {
    // The new chip appears out of nowhere printing a name the map has no
    // station for; without a sentence the reader cannot tell that from a bug.
    // (`LAUNCH_TITLE` beside it is a hardcoded English string — existing debt,
    // not a precedent: card 321 AC 9 asks for i18n with de AND en.)
    const title = /title="([^"]*)"/.exec(chipTag(markup(), "WebFetch"));
    expect(title, "the unmapped chip carries no tooltip").not.toBeNull();
    const shown = unescape(title![1]);
    const entry = Object.values(dict).find((e) => e.en === shown || e.de === shown);
    expect(entry, `"${shown}" is not a key in src/i18n/i18n.ts`).toBeDefined();
    expect(entry!.de.length, "de").toBeGreaterThan(0);
    expect(entry!.en.length, "en").toBeGreaterThan(0);
  });

  it("a mapped tool draws no name chip beside the chip it lights", () => {
    const m = renderToStaticMarkup(<AgentCardBody data={agentData("Bash", { command: "ls -la" })} />);
    expect(m).not.toContain(">Bash</span>");
    expect(chipTag(m, "run_command")).toContain("pf-chip--on");
  });
});

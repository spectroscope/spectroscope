// Card 471: /compact and /clear are commands of the web chat, not prompts.
// Card 554: every command of the web chat comes from the core list the server
// serves, and the parse reads it: a name, an optional second word, the words
// after it, and the aliases.
//
// The rules are pure and pinned here in node. A command is decided from the
// WHOLE draft on the client: the draft opens with the command, and a command
// that takes no words is exactly the command, give or take surrounding
// whitespace. Text that merely contains "/clear" somewhere is a prompt and
// goes to the model as written (card 471's security criterion).

import { afterEach, describe, expect, it } from "vitest";
import {
  commandFrame,
  confirmPlaybookFrame,
  decideDraft,
  graphAskFrame,
  helpText,
  loopFrame,
  loopStopFrame,
  noPlaybookFrame,
  offerCommands,
  opensWithCommand,
  parseLoop,
  parseSlash,
  setPlaybookFrame,
  startPlaybookFrame,
  startWorkflowFrame,
  WEB_COMMAND_IDS,
} from "./chatCommands";
import { __resetCommandList, webCommands } from "./commandList";
import { coreCommandRows } from "../testkit/commandRows";

/** Card 554: the list as the server serves it; the composer decides against it. */
const ROWS = coreCommandRows();

const decide = (draft: string) => decideDraft(draft, ROWS);

describe("parseSlash (card 554)", () => {
  const id = (draft: string): string | null => parseSlash(draft, ROWS)?.row.id ?? null;

  it("reads the main name and its alias as one command, with the words after it", () => {
    expect(parseSlash("/run-with-playbook add a CSV export", ROWS)).toMatchObject({
      row: { id: "run-with-playbook" },
      rest: "add a CSV export",
    });
    expect(parseSlash("/playbook run add a CSV export", ROWS)).toMatchObject({
      row: { id: "run-with-playbook" },
      rest: "add a CSV export",
    });
  });

  it("takes the longest spelling: a second word beats the bare name", () => {
    expect(id("/playbook")).toBe("playbook-current");
    expect(id("/playbook current")).toBe("playbook-current");
    expect(id("/playbook list")).toBe("playbook-list");
    expect(id("/playbook show")).toBe("playbook-show");
    expect(id("/playbook use spectro")).toBe("playbook-use");
    expect(id("/playbook workflow fanout-review")).toBe("playbook-workflow");
    expect(id("/run-workflow fanout-review")).toBe("playbook-workflow");
    expect(id("/commands")).toBe("help");
  });

  it("needs the end of the draft, a space or a line break after a spelling", () => {
    expect(id("/playbooks")).toBeNull();
    expect(id("/helpful")).toBeNull();
    expect(parseSlash("/run-with-playbook first line\nsecond line", ROWS)?.rest).toBe(
      "first line\nsecond line",
    );
    expect(parseSlash("/run-with-playbook\nadd it", ROWS)?.rest).toBe("add it");
  });

  it("knows only the web's wired rows", () => {
    expect(id("/goal the tests pass"), "a terminal command").toBeNull();
    expect(id("/model")).toBeNull();
    expect(id("please /help")).toBeNull();
    expect(id("/HELPS"), "a longer word in capitals is still no command").toBeNull();
  });
});

describe("decideDraft (card 554)", () => {
  it("runs a playbook on the prompt, by its main name and by the alias", () => {
    expect(decide("/run-with-playbook add a CSV export")).toEqual({
      kind: "runPlaybook",
      prompt: "add a CSV export",
    });
    expect(decide("  /playbook run add a CSV export  ")).toEqual({
      kind: "runPlaybook",
      prompt: "add a CSV export",
    });
  });

  it("hands an empty prompt on, so the refusal names the usage (criterion 1)", () => {
    expect(decide("/run-with-playbook")).toEqual({ kind: "runPlaybook", prompt: "" });
    expect(decide("/playbook run   ")).toEqual({ kind: "runPlaybook", prompt: "" });
  });

  it("reads the playbook rows", () => {
    expect(decide("/playbook")).toEqual({ kind: "playbookCurrent" });
    expect(decide("/playbook current")).toEqual({ kind: "playbookCurrent" });
    expect(decide("/playbook list")).toEqual({ kind: "playbookList" });
    expect(decide("/playbook show")).toEqual({ kind: "playbookShow", name: "" });
    // Integrator decision a: /playbook show [name] names any registered playbook.
    expect(decide("/playbook show team-x")).toEqual({ kind: "playbookShow", name: "team-x" });
  });

  it("keeps /playbook show a row Enter runs, and its help names the optional [name] (coordinator follow-up)", () => {
    const show = ROWS.find((r) => r.id === "playbook-show");
    expect(show?.takesArgs, "Enter on the picker row runs it for the current playbook").toBe(false);
    expect(show?.help.en).toContain("/playbook show [name]");
    // Card 588: the German comes from the list.
    expect(show?.help.de).toContain("/playbook show [Name]");
    expect(decide("/playbook use team-x")).toEqual({ kind: "playbookUse", name: "team-x" });
    expect(decide("/playbook use")).toEqual({ kind: "playbookUse", name: "" });
  });

  it("splits a workflow's name from its input, and the alias reads the same", () => {
    expect(decide("/playbook workflow fanout-review check the auth module")).toEqual({
      kind: "runWorkflow",
      name: "fanout-review",
      input: "check the auth module",
    });
    expect(decide("/run-workflow fanout-review")).toEqual({
      kind: "runWorkflow",
      name: "fanout-review",
      input: "",
    });
    expect(decide("/run-workflow")).toEqual({ kind: "runWorkflow", name: "", input: "" });
  });

  it("reads /help, its alias /commands, and /skills", () => {
    expect(decide("/help")).toEqual({ kind: "help" });
    expect(decide(" /commands ")).toEqual({ kind: "help" });
    expect(decide("/skills")).toEqual({ kind: "skills" });
  });

  it("keeps card 471's rule: a command without words is the whole draft, or the draft is a prompt", () => {
    expect(decide("/clear")).toEqual({ kind: "command", name: "clear" });
    expect(decide("\t/compact ")).toEqual({ kind: "command", name: "compact" });
    expect(decide("/clear the cache")).toEqual({ kind: "prompt", text: "/clear the cache" });
    expect(decide("/clear\n/compact")).toEqual({ kind: "prompt", text: "/clear\n/compact" });
    expect(decide("/help me write this")).toEqual({ kind: "prompt", text: "/help me write this" });
    expect(decide("/playbook list them all")).toEqual({ kind: "prompt", text: "/playbook list them all" });
    expect(decide("please /clear the cache")).toEqual({ kind: "prompt", text: "please /clear the cache" });
  });

  it("sends a skill token, an unknown name and a terminal command as the prompt they are", () => {
    expect(decide("/clean-code tidy this")).toEqual({ kind: "prompt", text: "/clean-code tidy this" });
    expect(decide("/model")).toEqual({ kind: "prompt", text: "/model" });
    expect(decide("/clearer")).toEqual({ kind: "prompt", text: "/clearer" });
  });

  it("sends nothing for a blank draft", () => {
    expect(decide("   ")).toBeNull();
  });
});

describe("the rows the web can run (card 554)", () => {
  it("are every wired web row of the core list, and only those", () => {
    // A row the core list gains for the web must be taught to the web, or
    // the picker would offer a command the composer cannot run.
    expect([...WEB_COMMAND_IDS].sort()).toEqual(
      webCommands(ROWS)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("each leave as their own decision, never as a prompt", () => {
    for (const row of webCommands(ROWS)) {
      const spelled = `/${row.sub === null ? row.name : `${row.name} ${row.sub}`}${row.takesArgs ? " x" : ""}`;
      expect(decide(spelled)?.kind, spelled).not.toBe("prompt");
    }
  });
});

describe("decideDraft, the one decision Chat.tsx reads (task 13)", () => {
  it("turns a draft that is compact or clear into the command", () => {
    expect(decide(" /clear ")).toEqual({ kind: "command", name: "clear" });
    expect(decide("/compact")).toEqual({ kind: "command", name: "compact" });
  });

  it("never turns a command of the list into a prompt", () => {
    expect(decide("/help")).toEqual({ kind: "help" });
    expect(decide("/run-with-playbook add a CSV export")).toEqual({
      kind: "runPlaybook",
      prompt: "add a CSV export",
    });
    expect(decide("/playbook list")).toEqual({ kind: "playbookList" });
  });

  it("sends anything else as the trimmed prompt, slashes and all", () => {
    expect(decide("  fix the /clear handling  ")).toEqual({
      kind: "prompt",
      text: "fix the /clear handling",
    });
    expect(decide("/clean-code tidy this")).toEqual({
      kind: "prompt",
      text: "/clean-code tidy this",
    });
  });

  it("sends nothing for a blank draft", () => {
    expect(decide("   ")).toBeNull();
  });
});

// Card 588, fix round M6: the picker's rows come from offerCommands alone.
describe("the picker's rows (card 554, read through offerCommands since card 588)", () => {
  const ids = (query: string, mode: "learn" | "light" | "developer") =>
    offerCommands(`/${query}`, query.length + 1, ROWS, mode)?.rows.map((r) => r.id) ?? [];

  // Card 588: a bare slash offers one row per command; a command's
  // subcommands follow once its name is typed. Card 587's /graph stands
  // between the chat and the skills, in every mode.
  it("offers one row per command on a bare slash in learn: chat, /graph, then /skills", () => {
    expect(ids("", "learn")).toEqual(["help", "compact", "clear", "loop", "graph", "skills"]);
    expect(ids("", "light")).toEqual(["help", "compact", "clear", "loop", "graph", "skills"]);
  });

  it("adds the playbook commands in developer, in the list's order, without their subcommands", () => {
    expect(ids("", "developer")).toEqual([
      "help",
      "compact",
      "clear",
      "loop",
      "run-with-playbook",
      "playbook-current",
      "graph",
      "skills",
    ]);
  });

  it("narrows by the front of a spelling or an alias, the exact one first in its group", () => {
    expect(ids("cl", "learn")).toEqual(["clear"]);
    // Card 587: /graph answers to /codegraph as well.
    expect(ids("c", "learn")).toEqual(["help", "compact", "clear", "graph"]);
    expect(ids("playbook", "developer")).toEqual([
      "playbook-current",
      "run-with-playbook",
      "playbook-list",
      "playbook-show",
      "playbook-use",
      "playbook-workflow",
    ]);
    expect(ids("run", "developer")).toEqual(["run-with-playbook", "playbook-workflow"]);
    expect(ids("run", "learn")).toEqual([]);
    expect(ids("x", "developer")).toEqual([]);
  });

  it("offers nothing to a slash that does not open the draft", () => {
    expect(offerCommands("please /", 8, ROWS, "developer")).toBeNull();
    expect(offerCommands("fix the /cl", 11, ROWS, "learn")).toBeNull();
    expect(ids("cl", "learn"), "premise: the same query at the start offers /clear").toEqual(["clear"]);
  });
});

describe("/graph (card 587)", () => {
  const graph = (action: string, question = "") => ({ kind: "graph", action, question });

  it("reads each subcommand, by the main name and by both old names", () => {
    for (const name of ["graph", "codegraph", "graphify"]) {
      expect(decide(`/${name} build`), name).toEqual(graph("build"));
      expect(decide(`/${name} update`), name).toEqual(graph("update"));
      expect(decide(`/${name} show`), name).toEqual(graph("show"));
      expect(decide(`/${name} help`), name).toEqual(graph("help"));
      expect(decide(`/${name} ask who calls PlaybookRunner.step`), name).toEqual(
        graph("ask", "who calls PlaybookRunner.step"),
      );
    }
  });

  it("answers /graph alone with its help", () => {
    expect(decide("/graph")).toEqual(graph("help"));
    expect(decide(" /codegraph ")).toEqual(graph("help"));
    expect(decide("/graphify")).toEqual(graph("help"));
  });

  it("hands an empty question on, so the page can name the usage", () => {
    expect(decide("/graph ask")).toEqual(graph("ask"));
    expect(decide("/graph ask   ")).toEqual(graph("ask"));
  });

  it("keeps card 471's rule: words after a subcommand that takes none make a prompt", () => {
    expect(decide("/graph build it now")).toEqual({ kind: "prompt", text: "/graph build it now" });
    expect(decide("/codegraph show me")).toEqual({ kind: "prompt", text: "/codegraph show me" });
    expect(decide("/graph of the imports")).toEqual({ kind: "prompt", text: "/graph of the imports" });
    expect(decide("/graphs")).toEqual({ kind: "prompt", text: "/graphs" });
  });

  it("asks the session with graph_ask, never as a user message", () => {
    expect(graphAskFrame("who calls X")).toEqual({ type: "graph_ask", question: "who calls X" });
  });
});

describe("the picker's offer (card 588)", () => {
  const offer = (draft: string, mode: "learn" | "light" | "developer" = "learn") =>
    offerCommands(draft, draft.length, ROWS, mode);
  const ids = (draft: string, mode: "learn" | "light" | "developer" = "learn") =>
    offer(draft, mode)?.rows.map((r) => r.id) ?? null;
  const GRAPH = ["graph", "graph-build", "graph-update", "graph-show", "graph-ask", "graph-help"];
  const PLAYBOOK = [
    "playbook-current",
    "run-with-playbook",
    "playbook-list",
    "playbook-show",
    "playbook-use",
    "playbook-workflow",
  ];

  it("lists a command's subcommands once its name is typed, the command itself first", () => {
    expect(ids("/graph")).toEqual(GRAPH);
    expect(ids("/gr")).toEqual(["graph"]);
  });

  it("keeps them after the space and narrows them by the second word", () => {
    expect(ids("/graph ")).toEqual(GRAPH);
    expect(ids("/graph b")).toEqual(["graph-build"]);
    expect(ids("/graph a")).toEqual(["graph-ask"]);
    expect(ids("/graph x")).toEqual([]);
  });

  it("reaches the subcommands through an old name", () => {
    expect(ids("/codegraph")).toEqual(GRAPH);
    expect(ids("/codegraph ")).toEqual(GRAPH);
    expect(ids("/graphify s")).toEqual(["graph-show"]);
  });

  it("lists list, show, use and workflow under /playbook, /playbook run among them, in developer only", () => {
    expect(ids("/playbook", "developer")).toEqual(PLAYBOOK);
    expect(ids("/playbook ", "developer")).toEqual(PLAYBOOK);
    expect(ids("/playbook u", "developer")).toEqual(["playbook-use"]);
    expect(ids("/playbook r", "developer")).toEqual(["run-with-playbook"]);
    expect(ids("/playbook", "learn")).toEqual([]);
  });

  it("names the command whose words are being typed, for its template, and offers no row", () => {
    expect(offer("/graph ask ")?.rows).toEqual([]);
    expect(offer("/graph ask ")?.writing?.id).toBe("graph-ask");
    expect(offer("/graph ask who calls PlaybookRunner.step")?.writing?.id).toBe("graph-ask");
    expect(offer("/codegraph ask who")?.writing?.id).toBe("graph-ask");
    expect(offer("/loop ")?.writing?.id).toBe("loop");
    expect(offer("/loop 5m check the build")?.writing?.id).toBe("loop");
    expect(offer("/playbook use spec", "developer")?.writing?.id).toBe("playbook-use");
    expect(offer("/graph build ")?.writing?.id).toBe("graph-build");
    expect(offer("/graph")?.writing).toBeNull();
    expect(offer("/nonsense words")?.writing).toBeNull();
  });

  it("reads only up to the caret", () => {
    expect(offerCommands("/gr", 3, ROWS, "learn")?.rows.map((r) => r.id)).toEqual(["graph"]);
    expect(
      offerCommands("/graph b  ", 8, ROWS, "learn")?.rows.map((r) => r.id),
      "space after the caret",
    ).toEqual(["graph-build"]);
  });

  // Fix round, I1: a row picked with text after the caret would be written
  // over that text, so the picker offers rows only where the caret ends the
  // draft. Inside a draft it names the command the whole draft spells, for
  // its template, and leaves Enter to the composer.
  it("offers no row while the caret is inside the draft, only the command the draft spells", () => {
    for (const at of [3, 7, 8]) {
      const inside = offerCommands("/graph ask who calls X", at, ROWS, "learn");
      expect(inside?.rows, `caret ${at}`).toEqual([]);
      expect(inside?.writing?.id, `caret ${at}`).toBe("graph-ask");
    }
    expect(offerCommands("/graph build", 3, ROWS, "learn")).toEqual({
      rows: [],
      writing: ROWS.find((r) => r.id === "graph-build"),
    });
    expect(offerCommands("/playbook use spec-review", 11, ROWS, "developer")?.writing?.id).toBe(
      "playbook-use",
    );
  });

  it("is nothing for a draft that is no command", () => {
    expect(offer("hello /graph")).toBeNull();
    expect(offer("/graph\nask")).toBeNull();
    expect(offer("")).toBeNull();
    expect(offer("graph")).toBeNull();
  });
});

// Card 588, round 2 (N1): whether the first word of a draft names a command,
// the check that keeps the picker from writing a skill over it.
describe("a draft that opens with a command", () => {
  it("is named by its first word, an alias too, in any case and in every mode", () => {
    expect(opensWithCommand("/graph ask who", ROWS)).toBe(true);
    expect(opensWithCommand("/GRAPH", ROWS)).toBe(true);
    expect(opensWithCommand("/codegraph build", ROWS)).toBe(true);
    expect(
      opensWithCommand("/playbook use spec-review", ROWS),
      "a developer row is typed in every mode",
    ).toBe(true);
    expect(opensWithCommand("/loop\nwatch the build", ROWS)).toBe(true);
  });

  it("is no command for a prefix, another word or a slash later in the text", () => {
    expect(opensWithCommand("/gra ask who", ROWS)).toBe(false);
    expect(opensWithCommand("/ver ask me", ROWS)).toBe(false);
    expect(opensWithCommand("please /graph", ROWS)).toBe(false);
    expect(opensWithCommand("/", ROWS)).toBe(false);
    expect(opensWithCommand("", ROWS)).toBe(false);
  });
});

// Card 588, fix round M2: command words are read in any case, the same way by
// the parse, the offer and the template; what follows them keeps its case.
describe("a command typed in capitals", () => {
  it("is the command, its words kept as typed", () => {
    expect(parseSlash("/GRAPH ask Who Calls X", ROWS)).toMatchObject({
      row: { id: "graph-ask" },
      rest: "Who Calls X",
    });
    expect(decide("/GRAPH ask who")).toEqual({ kind: "graph", action: "ask", question: "who" });
    expect(decide("/Graph Build")).toEqual({ kind: "graph", action: "build", question: "" });
    expect(decide("/HELP")).toEqual({ kind: "help" });
    expect(decide("/LOOP stop")).toEqual({ kind: "loopStop" });
    expect(decide("/Loop 5m Check The Build")).toEqual({
      kind: "loop",
      intervalSeconds: 300,
      prompt: "Check The Build",
    });
    expect(decide("/Playbook Use Team-X")).toEqual({ kind: "playbookUse", name: "Team-X" });
    // An old name reaches the parent row, which reads its subcommand in any case.
    expect(decide("/codegraph ASK who")).toEqual({ kind: "graph", action: "ask", question: "who" });
  });

  it("offers the same command and template", () => {
    expect(offerCommands("/GRAPH ask who", 14, ROWS, "learn")?.writing?.id).toBe("graph-ask");
    expect(offerCommands("/GRAPH A", 8, ROWS, "learn")?.rows.map((r) => r.id)).toEqual(["graph-ask"]);
  });
});

describe("the frames (card 554)", () => {
  it("names one socket frame per chat command, and neither is a user_message", () => {
    expect(commandFrame("compact")).toEqual({ type: "compact_context" });
    expect(commandFrame("clear")).toEqual({ type: "clear_context" });
  });

  it("asks the server to confirm a run with the prompt, the folder only when one is named", () => {
    expect(confirmPlaybookFrame("add a CSV export")).toEqual({
      type: "confirm_playbook",
      prompt: "add a CSV export",
    });
    expect(confirmPlaybookFrame("x", "/pb")).toEqual({ type: "confirm_playbook", prompt: "x", dir: "/pb" });
  });

  it("starts a confirmed run with the hash the sheet showed and the prompt", () => {
    expect(startPlaybookFrame("/pb", "sha256:ab", "add a CSV export")).toEqual({
      type: "start_playbook",
      dir: "/pb",
      hash: "sha256:ab",
      prompt: "add a CSV export",
    });
  });

  // Card 584: the models picked in the sheet ride along, and only when there are any.
  it("carries the picks of the sheet, and none when nothing was picked", () => {
    const picks = { write_plan: { provider: "ollama", model: "llama3:8b" } };
    expect(startPlaybookFrame("/pb", "sha256:ab", "x", picks)).toEqual({
      type: "start_playbook",
      dir: "/pb",
      hash: "sha256:ab",
      prompt: "x",
      picks,
    });
    expect(startPlaybookFrame("/pb", "sha256:ab", "x", {})).toEqual({
      type: "start_playbook",
      dir: "/pb",
      hash: "sha256:ab",
      prompt: "x",
    });
  });

  // Card 584, second fix round: the id the server's refusal of this start answers.
  it("carries the id the start asks with", () => {
    expect(startPlaybookFrame("/pb", "sha256:ab", "x", {}, "start-4")).toEqual({
      type: "start_playbook",
      dir: "/pb",
      hash: "sha256:ab",
      prompt: "x",
      ask: "start-4",
    });
  });

  it("starts a workflow by name with its input and the page language", () => {
    expect(startWorkflowFrame("fanout-review", "check auth", "de")).toEqual({
      type: "start_workflow",
      name: "fanout-review",
      input: "check auth",
      lang: "de",
    });
  });

  it("picks a playbook, or withdraws the pick with null", () => {
    expect(setPlaybookFrame("/pb")).toEqual({ type: "set_playbook", dir: "/pb" });
    expect(setPlaybookFrame(null)).toEqual({ type: "set_playbook", dir: null });
  });

  it("picks No playbook as a pick of its own (integrator decision b)", () => {
    expect(noPlaybookFrame()).toEqual({ type: "set_playbook", dir: null, none: true });
  });
});

describe("/help (card 554)", () => {
  it("lists the rows, grouped, each with its aliases and help", () => {
    const text = helpText(ROWS, "en", "learn");
    const lines = text.split("\n");
    expect(lines).toContain("Chat");
    expect(lines).toContain("/help, /commands: List every command with a short help");
    expect(lines).toContain("/clear: Start a fresh context in this session, the history stays visible");
    expect(lines).toContain("Skills");
    expect(lines.indexOf("Chat")).toBeLessThan(lines.indexOf("Skills"));
  });

  it("lists the playbook rows in developer under their group", () => {
    const lines = helpText(ROWS, "en", "developer").split("\n");
    expect(lines).toContain("Playbook");
    expect(lines).not.toContain("Playbook (developer mode)");
    expect(lines).toContain(
      "/run-with-playbook, /playbook run: Run your prompt through this session's playbook, step by step",
    );
    expect(lines).toContain("/playbook workflow, /run-workflow: Run a workflow of this playbook");
  });

  // Integrator decision c: /help names every command; the picker keeps the
  // developer rows to developer mode.
  it("lists the playbook rows outside developer too, their group marked developer mode", () => {
    for (const mode of ["learn", "light"] as const) {
      const lines = helpText(ROWS, "en", mode).split("\n");
      expect(lines, mode).toContain("Playbook (developer mode)");
      expect(lines, mode).not.toContain("Playbook");
      expect(lines, mode).toContain(
        "/run-with-playbook, /playbook run: Run your prompt through this session's playbook, step by step",
      );
      expect(lines.indexOf("Playbook (developer mode)"), mode).toBeGreaterThan(lines.indexOf("Chat"));
      expect(
        (offerCommands("/", 1, ROWS, mode)?.rows ?? []).some((r) => r.developerOnly),
        mode,
      ).toBe(false);
    }
    expect(helpText(ROWS, "de", "learn").split("\n")).toContain("Playbook (Entwicklermodus)");
  });

  it("names no terminal command", () => {
    const text = helpText(ROWS, "en", "developer");
    expect(text).not.toContain("/goal");
    expect(text).not.toContain("/exit");
  });

  it("lists /graph under the code graph group with its old names (card 587)", () => {
    const lines = helpText(ROWS, "en", "learn").split("\n");
    expect(lines).toContain("Code graph");
    expect(lines.indexOf("Code graph")).toBeGreaterThan(lines.indexOf("Chat"));
    expect(lines.find((l) => l.startsWith("/graph, /codegraph, /graphify: "))).toBeDefined();
    expect(lines).toContain("/graph ask: Ask a question the model answers through the code graph");
    expect(helpText(ROWS, "de", "learn").split("\n")).toContain("Code-Graph");
  });

  it("speaks German", () => {
    const lines = helpText(ROWS, "de", "learn").split("\n");
    expect(lines).toContain("/help, /commands: Jeden Befehl mit einer kurzen Hilfe auflisten");
    expect(lines[0]).toBe("Befehle, die du hier tippen kannst");
  });
});

describe("/loop (card 504)", () => {
  it("reads a leading interval in seconds, minutes and hours", () => {
    expect(parseLoop("/loop 2m check the CI")).toEqual({ intervalSeconds: 120, prompt: "check the CI" });
    expect(parseLoop("/loop 90s x")).toEqual({ intervalSeconds: 90, prompt: "x" });
    expect(parseLoop("/loop 1h x")).toEqual({ intervalSeconds: 3600, prompt: "x" });
  });

  it("is self paced without an interval", () => {
    expect(parseLoop("/loop watch the build")).toEqual({ intervalSeconds: null, prompt: "watch the build" });
  });

  it("hands the server an empty prompt, which it answers with the usage", () => {
    expect(parseLoop("/loop")).toEqual({ intervalSeconds: null, prompt: "" });
    expect(parseLoop("/loop 5m")).toEqual({ intervalSeconds: 300, prompt: "" });
  });

  it("is not a sentence that mentions it, nor a longer word", () => {
    expect(parseLoop("please /loop x")).toBeNull();
    expect(parseLoop("/looping x")).toBeNull();
    expect(decide("/looping x")).toEqual({ kind: "prompt", text: "/looping x" });
  });

  it("ends the loop on /loop stop, as the REPL does (fix round 1)", () => {
    expect(decide("/loop stop")).toEqual({ kind: "loopStop" });
    expect(decide("  /loop   stop  ")).toEqual({ kind: "loopStop" });
    expect(loopStopFrame()).toEqual({ type: "set_loop", action: "stop" });
    // A task that only starts with the word is still a loop.
    expect(decide("/loop stop the flaky test")).toEqual({
      kind: "loop",
      intervalSeconds: null,
      prompt: "stop the flaky test",
    });
    expect(decide("/loop 5m stop")).toEqual({
      kind: "loop",
      intervalSeconds: 300,
      prompt: "stop",
    });
  });

  it("is decided by the composer and leaves as set_loop", () => {
    expect(decide("/loop 2m check")).toEqual({
      kind: "loop",
      intervalSeconds: 120,
      prompt: "check",
    });
    expect(loopFrame({ intervalSeconds: 120, prompt: "check" })).toEqual({
      type: "set_loop",
      action: "start",
      prompt: "check",
      intervalSeconds: 120,
    });
    expect(loopFrame({ intervalSeconds: null, prompt: "watch" })).toEqual({
      type: "set_loop",
      action: "start",
      prompt: "watch",
    });
  });
});

describe("a slash draft before the command list arrived (card 554, criterion 8h)", () => {
  afterEach(() => {
    __resetCommandList();
  });

  it("is held, whatever command or skill it names, and never becomes a prompt", () => {
    for (const draft of ["/clear", "/run-with-playbook add a CSV export", "/clean-code tidy this", "/"]) {
      expect(decideDraft(draft, null), draft).toEqual({ kind: "held" });
    }
  });

  it("lets a draft without a leading slash go as before", () => {
    expect(decideDraft("fix the /clear handling", null)).toEqual({
      kind: "prompt",
      text: "fix the /clear handling",
    });
    expect(decideDraft("   ", null)).toBeNull();
  });
});

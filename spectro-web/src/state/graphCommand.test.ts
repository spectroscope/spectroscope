// Card 587: what /graph does on the page. build and update start the job the
// folder chip menu starts (POST /api/codegraph/start, no community names) and
// report its end in the chat; show opens the graph as the menu's Show row
// does; ask leaves as graph_ask on the session's own socket; help lists the
// subcommands. Pure over injected reads, so no server and no timers.

import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../events";
import type { Lang } from "../i18n/i18n";
import type { CodeGraphJob, CodeGraphStatus, StartBody } from "../codegraph/codeGraphModel";
import { coreCommandRows } from "../testkit/commandRows";
import { graphHelpText, runGraphCommand, MAX_MISSES, type GraphDeps, type GraphAction } from "./graphCommand";
import type { LocalLine } from "./pageCommands";
import { isTypedCommand } from "./typedCommand";

const ROWS = coreCommandRows();
const STARTED = "2026-10-13T10:00:00Z";

function job(
  state: CodeGraphJob["state"],
  mode: CodeGraphJob["mode"] = "full",
  over: Partial<CodeGraphJob> = {},
): CodeGraphJob {
  return {
    folder: "/work/app",
    sessionId: "s1",
    mode,
    state,
    startedAt: STARTED,
    endedAt: state === "running" ? null : "2026-10-13T10:00:05Z",
    exitCode: state === "failed" ? 1 : state === "ok" ? 0 : null,
    lastLine: state === "failed" ? "ModuleNotFoundError: tree_sitter" : "done",
    tail: [],
    ...over,
  };
}

function status(over: Partial<CodeGraphStatus> = {}): CodeGraphStatus {
  return {
    installed: true,
    binary: "/opt/tools/graphify",
    searched: [],
    install: "uv tool install graphifyy",
    folder: "/work/app",
    graph: { exists: true, modifiedAt: STARTED },
    job: null,
    backends: [],
    backend: "graphify",
    result: null,
    ...over,
  };
}

const NO_GRAPH = { graph: { exists: false, modifiedAt: null } };

function harness(
  statuses: (CodeGraphStatus | null)[],
  start: { status: number; message?: string; job?: CodeGraphJob } = { status: 202, job: job("running") },
) {
  const lines: LocalLine[] = [];
  const frames: ClientMessage[] = [];
  const opened: string[] = [];
  const posted: StartBody[] = [];
  const asked: string[] = [];
  let refreshed = 0;
  let read = 0;
  const deps: GraphDeps = {
    sessionId: () => "s1",
    fetchStatus: async (id) => {
      asked.push(id);
      const next = statuses[Math.min(read, statuses.length - 1)];
      read++;
      return next ?? null;
    },
    postStart: async (body) => {
      posted.push(body);
      return start;
    },
    openGraph: (id) => void opened.push(id),
    refresh: () => void refreshed++,
    sleep: async () => {},
  };
  const host = (lang: Lang = "en", sends = true) => ({
    rows: ROWS,
    lang,
    sendSession: (frame: ClientMessage) => {
      frames.push(frame);
      return sends;
    },
    line: (line: LocalLine) => void lines.push(line),
  });
  return { deps, host, lines, frames, opened, posted, asked, refreshed: () => refreshed };
}

async function run(
  h: ReturnType<typeof harness>,
  action: GraphAction,
  question = "",
  lang: Lang = "en",
): Promise<boolean> {
  const done = runGraphCommand(action, question, h.host(lang), h.deps);
  await done.settled;
  return done.accepted;
}

describe("/graph help (criterion 4)", () => {
  it("lists every subcommand with one line each, from the list", () => {
    const text = graphHelpText(ROWS, "en");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Code graph commands");
    expect(lines).toContain("/graph build: Build the code graph of this folder from its code");
    expect(lines).toContain("/graph update: Update the code graph with the code that changed");
    expect(lines).toContain("/graph show: Open the code graph in the browser panel");
    expect(lines).toContain("/graph ask: Ask a question the model answers through the code graph");
    expect(lines).toContain("/graph help: List the graph subcommands with one line each");
    expect(lines).toContain("/codegraph and /graphify work the same as /graph.");
    const subs = ROWS.filter((r) => r.name === "graph" && r.sub !== null);
    expect(lines.filter((l) => l.startsWith("/graph ")).length, "one line per sub row").toBe(subs.length);
  });

  it("speaks German", () => {
    const lines = graphHelpText(ROWS, "de").split("\n");
    expect(lines[0]).toBe("Befehle für den Code-Graphen");
    expect(lines).toContain("/graph build: Den Code-Graphen dieses Ordners aus seinem Code bauen");
    expect(lines).toContain("/codegraph und /graphify wirken genauso wie /graph.");
  });

  it("answers as one line of the chat", async () => {
    const h = harness([]);
    expect(await run(h, "help")).toBe(true);
    expect(h.lines).toEqual([{ text: graphHelpText(ROWS, "en") }]);
    expect(h.asked, "help reads nothing").toEqual([]);
  });
});

describe("/graph build and update (criteria 2 and 6)", () => {
  it("starts the menu's job without names and reports the build with its size", async () => {
    const h = harness([
      status(NO_GRAPH),
      status({ ...NO_GRAPH, job: job("running") }),
      status({ job: job("ok"), result: { kind: "built", counts: "5 nodes, 7 edges, 2 communities" } }),
    ]);
    expect(await run(h, "build")).toBe(true);
    expect(h.posted).toEqual([{ sessionId: "s1", mode: "full", provider: null, model: null }]);
    expect(h.lines.map((l) => l.text)).toEqual([
      "Building the code graph of /work/app. The result follows here; the header shows the progress.",
      "Built the code graph of /work/app: 5 nodes, 7 edges, 2 communities.",
    ]);
    expect(h.refreshed()).toBeGreaterThanOrEqual(2);
  });

  it("says it in German, the size in German words", async () => {
    const h = harness([
      status(NO_GRAPH),
      status({ job: job("ok"), result: { kind: "built", counts: "5 nodes, 7 edges, 2 communities" } }),
    ]);
    await run(h, "build", "", "de");
    expect(h.lines[1]?.text).toBe("Code-Graph von /work/app gebaut: 5 Knoten, 7 Kanten, 2 Gruppen.");
  });

  it("says an update that changed nothing is already current", async () => {
    const h = harness([
      status(),
      status({ job: job("ok", "update"), result: { kind: "current", counts: null } }),
    ]);
    await run(h, "update");
    expect(h.posted[0]?.mode).toBe("update");
    expect(h.lines.map((l) => l.text)).toEqual([
      "Updating the code graph of /work/app. The result follows here; the header shows the progress.",
      "The code graph of /work/app is already current: the structure of the code is the same as at the last build.",
    ]);
  });

  // Fix round, I1: "updated" needs the size graphify prints after a rebuild,
  // "current" its line that nothing changed. Without either the chat says no
  // more than that the update finished, and so for a server that sends no result.
  it("says only that an update finished when the server read no change and no size", async () => {
    for (const result of [{ kind: "finished" as const, counts: null }, null]) {
      const h = harness([status(), status({ job: job("ok", "update"), result })]);
      await run(h, "update");
      expect(h.lines[1], JSON.stringify(result)).toEqual({
        text: "The update of the code graph of /work/app finished.",
      });
    }
    const de = harness([
      status(),
      status({ job: job("ok", "update"), result: { kind: "finished", counts: null } }),
    ]);
    await run(de, "update", "", "de");
    expect(de.lines[1]?.text).toBe("Die Aktualisierung des Code-Graphen von /work/app ist abgeschlossen.");
  });

  it("says in German that an update changed nothing in the structure", async () => {
    const h = harness([
      status(),
      status({ job: job("ok", "update"), result: { kind: "current", counts: null } }),
    ]);
    await run(h, "update", "", "de");
    expect(h.lines[1]?.text).toBe(
      "Der Code-Graph von /work/app ist schon aktuell: die Struktur des Codes ist dieselbe wie beim letzten Build.",
    );
  });

  it("says an update that changed the graph is updated, with the new size", async () => {
    const h = harness([
      status(),
      status({
        job: job("ok", "update"),
        result: { kind: "updated", counts: "6 nodes, 8 edges, 2 communities" },
      }),
    ]);
    await run(h, "update");
    expect(h.lines[1]?.text).toBe("Updated the code graph of /work/app: 6 nodes, 8 edges, 2 communities.");
  });

  it("names a failure with its exit code and the last line", async () => {
    const h = harness([
      status(NO_GRAPH),
      status({ job: job("failed"), result: { kind: "failed", counts: null } }),
    ]);
    await run(h, "build");
    const last = h.lines[h.lines.length - 1];
    expect(last?.tone).toBe("warn");
    expect(last?.text).toContain("exit 1");
    expect(last?.text).toContain("ModuleNotFoundError: tree_sitter");
  });

  it("says graphify is missing and how to install it, and starts nothing", async () => {
    const h = harness([status({ installed: false, binary: null })]);
    await run(h, "build");
    expect(h.posted).toEqual([]);
    expect(h.lines).toEqual([
      {
        text: "graphify is not installed. Install it in a terminal with uv tool install graphifyy, then type /graph build again.",
        tone: "warn",
      },
    ]);
  });

  it("says the same when the server finds the program gone at the start", async () => {
    const h = harness([status(NO_GRAPH)], { status: 503, message: "graphify is not installed." });
    await run(h, "build");
    expect(h.lines[0]?.tone).toBe("warn");
    expect(h.lines[0]?.text).toContain("uv tool install graphifyy");
  });

  it("names the backend the setting chose, not graphify", async () => {
    const h = harness([status({ installed: false, backend: "othergraph", install: "brew install og" })]);
    await run(h, "update");
    expect(h.lines[0]?.text).toBe(
      "othergraph is not installed. Install it in a terminal with brew install og, then type /graph update again.",
    );
  });

  it("refuses an update where there is no graph yet, and points at build", async () => {
    const h = harness([status(NO_GRAPH)]);
    await run(h, "update");
    expect(h.posted).toEqual([]);
    expect(h.lines).toEqual([
      { text: "This folder has no code graph yet. /graph build builds it.", tone: "warn" },
    ]);
  });

  it("follows a build that already runs instead of starting a second one", async () => {
    const h = harness([
      status({ job: job("running", "update") }),
      status({ job: job("ok", "update"), result: { kind: "current", counts: null } }),
    ]);
    await run(h, "update");
    expect(h.posted).toEqual([]);
    expect(h.lines.map((l) => l.text)).toEqual([
      "A code graph build is already running for this folder. Its result follows here.",
      "The code graph of /work/app is already current: the structure of the code is the same as at the last build.",
    ]);
  });

  it("follows the running build after a start the server refused as busy", async () => {
    const h = harness(
      [
        status(NO_GRAPH),
        status({ job: job("running") }),
        status({ job: job("ok"), result: { kind: "built", counts: null } }),
      ],
      { status: 409, message: "A code graph build is already running for this folder." },
    );
    await run(h, "build");
    expect(h.lines.map((l) => l.text)).toEqual([
      "A code graph build is already running for this folder. Its result follows here.",
      "Built the code graph of /work/app.",
    ]);
  });

  it("says so when the server no longer reports the build it started", async () => {
    const h = harness([
      status(NO_GRAPH),
      status({ job: job("running", "full", { startedAt: "2026-10-13T11:00:00Z" }) }),
    ]);
    await run(h, "build");
    expect(h.lines[1]).toEqual({
      text: "The server no longer reports this build, so its result is unknown. The header shows the state of the graph.",
      tone: "warn",
    });
  });

  it("gives up after the status could not be read that many times in a row", async () => {
    const h = harness([status(NO_GRAPH), null]);
    await run(h, "build");
    expect(h.asked.length).toBe(1 + MAX_MISSES);
    expect(h.lines[1]?.tone).toBe("warn");
  });

  it("needs a session, as the menu rows do", async () => {
    const h = harness([status()]);
    h.deps.sessionId = () => null;
    await run(h, "build");
    expect(h.asked).toEqual([]);
    expect(h.lines).toEqual([{ text: "Available after the first message", tone: "warn" }]);
  });

  it("says so when the status cannot be read", async () => {
    const h = harness([null]);
    await run(h, "build");
    expect(h.posted).toEqual([]);
    expect(h.lines).toEqual([{ text: "The code graph status could not be read.", tone: "warn" }]);
  });

  it("runs nothing where the page cannot show a line", async () => {
    const h = harness([status()]);
    const done = runGraphCommand("build", "", { rows: ROWS, lang: "en", sendSession: () => true }, h.deps);
    await done.settled;
    expect(done.accepted).toBe(false);
    expect(h.asked, "no status read").toEqual([]);
    expect(h.posted, "no build started").toEqual([]);
    expect(h.opened, "no graph opened").toEqual([]);
    const shown = harness([status()]);
    await run(shown, "build");
    expect(shown.asked.length, "premise: with a line the same command reads the status").toBeGreaterThan(0);
  });

  // Fix round, M3: an error a step throws is named, not read as a status the
  // server did not answer.
  it("names the error a step threw", async () => {
    const h = harness([status()]);
    h.deps.openGraph = () => {
      throw new Error("the browser panel is closed");
    };
    await run(h, "show");
    expect(h.lines).toEqual([
      { text: "The /graph command stopped with an error: the browser panel is closed", tone: "warn" },
    ]);
    const posting = harness([status()]);
    posting.deps.postStart = async () => {
      throw new Error("socket hang up");
    };
    await run(posting, "build", "", "de");
    expect(posting.lines).toEqual([
      { text: "Der Befehl /graph brach mit einem Fehler ab: socket hang up", tone: "warn" },
    ]);
  });
});

describe("/graph show (criterion 2)", () => {
  it("opens the graph the way the menu's Show row does, and says so", async () => {
    const h = harness([status()]);
    await run(h, "show");
    expect(h.opened).toEqual(["s1"]);
    expect(h.lines).toEqual([{ text: "Opened the code graph of /work/app in the browser panel." }]);
  });

  it("refuses a folder without a graph and points at build", async () => {
    const h = harness([status(NO_GRAPH)]);
    await run(h, "show");
    expect(h.opened).toEqual([]);
    expect(h.lines[0]?.text).toBe("This folder has no code graph yet. /graph build builds it.");
  });
});

describe("/graph ask (criterion 3)", () => {
  it("leaves as graph_ask on the session's own socket, tagged as a typed command", async () => {
    const h = harness([]);
    expect(await run(h, "ask", "who calls PlaybookRunner.step")).toBe(true);
    expect(h.frames).toEqual([{ type: "graph_ask", question: "who calls PlaybookRunner.step" }]);
    expect(isTypedCommand(h.frames[0] as ClientMessage)).toBe(true);
    expect(h.lines).toEqual([]);
  });

  it("keeps the draft and names the usage for an empty question", async () => {
    const h = harness([]);
    expect(await run(h, "ask", "  ")).toBe(false);
    expect(h.frames).toEqual([]);
    expect(h.lines).toEqual([{ text: "/graph ask needs a question: /graph ask <question>", tone: "warn" }]);
  });

  it("keeps the draft when the frame did not leave", async () => {
    const h = harness([]);
    const done = runGraphCommand("ask", "who calls X", h.host("en", false), h.deps);
    expect(done.accepted).toBe(false);
    expect(h.lines[0]?.tone).toBe("warn");
  });
});

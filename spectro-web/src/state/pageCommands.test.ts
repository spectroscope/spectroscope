// Card 554, task 13: what the composer does with a command that is neither
// /compact, /clear nor /loop. Three of them leave as frames of the session,
// always through the host's sendSession, which App points at the session's
// own socket (sessionFrame): /run-with-playbook asks for the start sheet,
// /playbook workflow starts a workflow at once, /playbook use picks a
// playbook. The others are answered on the page as one info line: /help,
// /playbook, /playbook list and /playbook show; /skills opens the Skills and
// Commands view. A host that cannot show a line (the Lab) runs none of the
// page's answers, and the draft stays.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../events";
import { coreCommandRows } from "../testkit/commandRows";
import { helpText } from "./chatCommands";
import { runPageCommand, type LocalLine, type PageCommandHost } from "./pageCommands";
import type { PlaybookPick } from "./playbookChat";

const ROWS = coreCommandRows();

let frames: ClientMessage[] = [];
let lines: LocalLine[] = [];
let skillsOpened = 0;
let accept = true;

function host(over: Partial<PageCommandHost> = {}): PageCommandHost {
  return {
    rows: ROWS,
    lang: "en",
    mode: "developer",
    pick: null,
    workspace: "/ws",
    sendSession: (frame) => {
      frames.push(frame);
      return accept;
    },
    line: (line) => void lines.push(line),
    openSkills: () => void skillsOpened++,
    ...over,
  };
}

const LOADED = {
  dir: "/pb/spectro",
  findings: [],
  topology: { entry: "go", nodes: [], edges: [] },
  steps: [],
  playbook: {
    id: "spectro",
    name: "spectro",
    description: "",
    start: "go",
    nodes: [],
    arrows: [],
    models: {},
    documents: {},
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  },
};

/** The server: two registered folders, one pinned for /ws, both load. */
function server(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/playbooks?") || url === "/api/playbooks") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ folders: ["/pb/spectro", "/pb/team-x"], active: "/pb/spectro" }),
        });
      }
      const dir = decodeURIComponent(/dir=([^&]*)/.exec(url)?.[1] ?? "");
      const name = dir.endsWith("team-x") ? "Team X" : "spectro";
      return Promise.resolve({
        ok: true,
        json: async () => ({ ...LOADED, dir, playbook: { ...LOADED.playbook, name } }),
      });
    }),
  );
}

beforeEach(() => {
  frames = [];
  lines = [];
  skillsOpened = 0;
  accept = true;
  server();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the commands that leave as frames of the session", () => {
  it("asks the server for the start sheet with the prompt", () => {
    expect(runPageCommand({ kind: "runPlaybook", prompt: "add a CSV export" }, host()).accepted).toBe(true);
    expect(frames).toEqual([{ type: "confirm_playbook", prompt: "add a CSV export" }]);
    expect(lines).toEqual([]);
  });

  it("hands an empty prompt to the server, whose usage line refuses it (criterion 1)", () => {
    runPageCommand({ kind: "runPlaybook", prompt: "" }, host());
    expect(frames).toEqual([{ type: "confirm_playbook", prompt: "" }]);
  });

  it("starts a workflow by name with its input and the page language, at once", () => {
    runPageCommand({ kind: "runWorkflow", name: "fan", input: "check auth" }, host({ lang: "de" }));
    expect(frames).toEqual([{ type: "start_workflow", name: "fan", input: "check auth", lang: "de" }]);
  });

  it("keeps the draft when the frame did not leave", () => {
    accept = false;
    expect(runPageCommand({ kind: "runPlaybook", prompt: "x" }, host()).accepted).toBe(false);
    expect(runPageCommand({ kind: "runWorkflow", name: "fan", input: "" }, host()).accepted).toBe(false);
  });

  it("picks a playbook by name through the session and says so", async () => {
    const run = runPageCommand({ kind: "playbookUse", name: "Team X" }, host());
    expect(run.accepted).toBe(true);
    await run.settled;
    expect(frames).toEqual([{ type: "set_playbook", dir: "/pb/team-x" }]);
    expect(lines).toEqual([{ text: "This session now uses the playbook Team X (/pb/team-x)." }]);
  });

  it("refuses an unknown name with the candidates and sends nothing", async () => {
    await runPageCommand({ kind: "playbookUse", name: "nope" }, host()).settled;
    expect(frames).toEqual([]);
    expect(lines).toEqual([
      {
        text: "No playbook is named nope. You can use: spectro (/pb/spectro), Team X (/pb/team-x)",
        tone: "warn",
      },
    ]);
  });

  it("says when a pick could not leave", async () => {
    accept = false;
    await runPageCommand({ kind: "playbookUse", name: "spectro" }, host()).settled;
    expect(lines).toEqual([
      { text: "The pick was not sent: the session is closed or its connection is down.", tone: "warn" },
    ]);
  });
});

describe("the commands the page answers", () => {
  it("answers /help with the grouped rows of the list, in the page's language and mode", () => {
    expect(runPageCommand({ kind: "help" }, host({ lang: "de", mode: "learn" })).accepted).toBe(true);
    expect(lines).toEqual([{ text: helpText(ROWS, "de", "learn") }]);
    expect(frames).toEqual([]);
  });

  it("opens the Skills and Commands view for /skills", () => {
    expect(runPageCommand({ kind: "skills" }, host()).accepted).toBe(true);
    expect(skillsOpened).toBe(1);
  });

  it("names the session's pick without asking the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pick: PlaybookPick = { dir: "/pb/team-x", name: "Team X", found: true };
    await runPageCommand({ kind: "playbookCurrent" }, host({ pick })).settled;
    expect(lines).toEqual([{ text: "Current playbook: Team X\nFolder: /pb/team-x\nSource: picked" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the folder's pin as the suggestion when nothing is picked", async () => {
    await runPageCommand({ kind: "playbookCurrent" }, host()).settled;
    expect(lines).toEqual([
      { text: "Current playbook: spectro\nFolder: /pb/spectro\nSource: suggested from the folder pin" },
    ]);
  });

  it("lists the registered playbooks with the current one marked", async () => {
    await runPageCommand({ kind: "playbookList" }, host()).settled;
    expect(lines).toEqual([
      {
        text: "Playbooks you can use:\n- spectro (/pb/spectro) (suggested for this folder)\n- Team X (/pb/team-x)",
      },
    ]);
  });

  it("shows a playbook with the link that opens its Steps tab", async () => {
    await runPageCommand({ kind: "playbookShow", name: "Team X" }, host()).settled;
    expect(lines).toHaveLength(1);
    expect(lines[0].text.split("\n")[0]).toBe("Playbook Team X");
    expect(lines[0].openPlaybook).toBe("/pb/team-x");
  });

  it("says when the server could not be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await runPageCommand({ kind: "playbookList" }, host()).settled;
    expect(lines).toEqual([{ text: "The playbook folders could not be read.", tone: "warn" }]);
  });

  it("runs none of the page's answers in a host that cannot show a line, and keeps the draft", async () => {
    for (const decided of [
      { kind: "help" },
      { kind: "playbookCurrent" },
      { kind: "playbookList" },
      { kind: "playbookShow", name: "" },
      { kind: "playbookUse", name: "spectro" },
    ] as const) {
      const run = runPageCommand(decided, host({ line: undefined }));
      expect(run.accepted, decided.kind).toBe(false);
      await run.settled;
    }
    expect(runPageCommand({ kind: "skills" }, host({ openSkills: undefined })).accepted).toBe(false);
    expect(frames).toEqual([]);
  });
});

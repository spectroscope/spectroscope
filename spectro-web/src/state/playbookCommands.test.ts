// Card 554, task 13, integrator decision a: the playbook commands the chat
// answers on the page. /playbook names the current playbook and where it
// comes from, /playbook list the registered folders with the current one
// marked, /playbook show [name] the steps, gates, models and contents counts,
// and /playbook use <name> resolves a name to one registered folder or refuses
// with the candidates. EN and DE.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentLine,
  currentOf,
  folderName,
  listLine,
  readFolders,
  readLoaded,
  readNames,
  resolveName,
  showLine,
  showTarget,
  type NamedFolder,
} from "./playbookCommands";
import type { LoadedPlaybook } from "./playbooks";

const NAMED: NamedFolder[] = [
  { dir: "/pb/spectro", name: "spectro" },
  { dir: "/home/team-x", name: "Team X" },
  { dir: "/other/spectro-copy", name: "spectro" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the current playbook and its source", () => {
  it("is the pick, else the pin as a suggestion, else none; an explicit none is none", () => {
    expect(currentOf({ dir: "/pb/a", name: "A", found: true }, "/pb/b")).toEqual({
      source: "picked",
      dir: "/pb/a",
      name: "A",
      found: true,
    });
    expect(currentOf({ dir: null, name: null, found: false }, "/pb/b")).toEqual({
      source: "suggested",
      dir: "/pb/b",
    });
    expect(currentOf(null, "/pb/b")).toEqual({ source: "suggested", dir: "/pb/b" });
    expect(currentOf({ dir: null, name: null, found: false, none: true }, "/pb/b")).toEqual({
      source: "none",
    });
    expect(currentOf(null, null)).toEqual({ source: "nothing" });
  });

  it("says name, folder and source in English", () => {
    expect(currentLine({ source: "picked", dir: "/pb/a", name: "A", found: true }, null, "en")).toBe(
      "Current playbook: A\nFolder: /pb/a\nSource: picked",
    );
    expect(currentLine({ source: "suggested", dir: "/pb/b" }, "B", "en")).toBe(
      "Current playbook: B\nFolder: /pb/b\nSource: suggested from the folder pin",
    );
    expect(currentLine({ source: "picked", dir: "/pb/gone", name: null, found: false }, null, "en")).toBe(
      "Current playbook: not found\nFolder: /pb/gone\nSource: picked",
    );
    expect(currentLine({ source: "none" }, null, "en")).toBe(
      'Current playbook: none\nSource: you picked "No playbook"',
    );
    expect(currentLine({ source: "nothing" }, null, "en")).toBe(
      "Current playbook: none\nPick one in the header dropdown in developer mode, or with /playbook use <name>.",
    );
  });

  it("takes the folder's name when the name is not known yet", () => {
    expect(currentLine({ source: "picked", dir: "/pb/alpha", name: null, found: null }, null, "en")).toBe(
      "Current playbook: alpha\nFolder: /pb/alpha\nSource: picked",
    );
    expect(folderName("/a/b/")).toBe("b");
  });

  it("speaks German", () => {
    expect(currentLine({ source: "suggested", dir: "/pb/b" }, "B", "de")).toBe(
      "Aktuelles Playbook: B\nOrdner: /pb/b\nQuelle: Vorschlag, für diesen Ordner hinterlegt",
    );
    expect(currentLine({ source: "none" }, null, "de")).toBe(
      "Aktuelles Playbook: keines\nQuelle: du hast „Kein Playbook“ gewählt",
    );
  });
});

describe("/playbook list", () => {
  it("names every registered folder and marks the current one", () => {
    const picked = currentOf({ dir: "/home/team-x", name: "Team X", found: true }, "/pb/spectro");
    expect(listLine(NAMED, picked, "en")).toBe(
      [
        "Playbooks you can use:",
        "- spectro (/pb/spectro)",
        "- Team X (/home/team-x) (current)",
        "- spectro (/other/spectro-copy)",
      ].join("\n"),
    );
  });

  it("marks the folder pin as the suggestion when nothing is picked", () => {
    const text = listLine(NAMED, currentOf(null, "/pb/spectro"), "en");
    expect(text.split("\n")[1]).toBe("- spectro (/pb/spectro) (suggested for this folder)");
  });

  it("marks nothing for an explicit none, and names a folder that does not read by its folder", () => {
    const text = listLine(
      [{ dir: "/pb/broken", name: null }],
      currentOf({ dir: null, name: null, found: false, none: true }, "/pb/broken"),
      "en",
    );
    expect(text).toBe("Playbooks you can use:\n- broken (/pb/broken)");
  });

  it("says how to add one when none is registered, in both languages", () => {
    expect(listLine([], currentOf(null, null), "en")).toBe(
      "No playbook folder is registered yet. Add one in the Playbook view.",
    );
    expect(listLine([], currentOf(null, null), "de")).toBe(
      "Noch ist kein Playbook-Ordner eingetragen. Füge einen in der Playbook-Ansicht hinzu.",
    );
  });
});

describe("/playbook use <name>", () => {
  it("resolves a playbook name, a folder name or a folder path to one folder", () => {
    expect(resolveName("Team X", NAMED, "en")).toEqual({ dir: "/home/team-x", name: "Team X" });
    expect(resolveName("team x", NAMED, "en")).toEqual({ dir: "/home/team-x", name: "Team X" });
    expect(resolveName("team-x", NAMED, "en")).toEqual({ dir: "/home/team-x", name: "Team X" });
    expect(resolveName("spectro-copy", NAMED, "en")).toEqual({ dir: "/other/spectro-copy", name: "spectro" });
    expect(resolveName("/pb/spectro", NAMED, "en")).toEqual({ dir: "/pb/spectro", name: "spectro" });
  });

  it("refuses an unknown name with the candidates", () => {
    expect(resolveName("nope", NAMED, "en")).toEqual({
      refusal:
        "No playbook is named nope. You can use: spectro (/pb/spectro), Team X (/home/team-x), spectro (/other/spectro-copy)",
    });
    expect(resolveName("nope", [], "en")).toEqual({
      refusal: "No playbook is named nope, and no playbook folder is registered yet.",
    });
  });

  it("refuses an ambiguous name with the folders it matches", () => {
    expect(resolveName("spectro", NAMED, "en")).toEqual({
      refusal:
        "spectro names more than one playbook: spectro (/pb/spectro), spectro (/other/spectro-copy). Name it by its folder.",
    });
    expect(resolveName("spectro", NAMED, "de")).toEqual({
      refusal:
        "spectro passt auf mehr als ein Playbook: spectro (/pb/spectro), spectro (/other/spectro-copy). Nenne es über seinen Ordner.",
    });
  });

  it("refuses an empty name with the usage", () => {
    expect(resolveName("  ", NAMED, "en")).toEqual({
      refusal: "Usage: /playbook use <name>; /playbook list names them.",
    });
  });
});

const LOADED: LoadedPlaybook = {
  dir: "/pb/spectro",
  findings: [],
  topology: { entry: "classify", nodes: [], edges: [] },
  steps: [
    {
      id: "classify",
      skills: [],
      model: { choice: "cheap", provider: "ollama", model: "qwen3:8b", state: "ok", reason: null },
    },
    { id: "build", skills: [], model: null },
  ],
  playbook: {
    id: "spectro",
    name: "spectro",
    description: "d",
    start: "classify",
    nodes: [
      {
        kind: "step",
        id: "classify",
        name: "Classify",
        performer: "chat",
        skills: [],
        model: "cheap",
        privacy: "cheap",
        consumes: [],
        produces: [],
        nod: false,
      },
      {
        kind: "decision",
        id: "tests",
        name: "Tests pass",
        check: "tests_green",
        outcomes: ["pass", "fail"],
        maxRounds: 3,
      },
      {
        kind: "step",
        id: "build",
        name: "Build",
        performer: "child",
        skills: [],
        model: "strong",
        privacy: "private",
        consumes: [],
        produces: [],
        nod: true,
      },
      { kind: "end", id: "done", result: "done" },
    ],
    arrows: [],
    models: {
      cheap: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] },
      strong: { primary: { provider: "anthropic", model: "claude-x" }, fallbacks: [] },
    },
    documents: {},
    contents: { skills: ["a", "b"], agents: ["c"], hooks: [], commands: ["d"], workflows: ["e", "f"] },
  },
};

describe("/playbook show [name]", () => {
  it("names the steps with their models, the gates, the models and the contents counts", () => {
    expect(showLine(LOADED, "en")).toBe(
      [
        "Playbook spectro",
        "Folder: /pb/spectro",
        "Steps:",
        "1. Classify: ollama qwen3:8b",
        "2. Build: strong",
        "Gates:",
        "- Tests pass (tests_green)",
        "Models:",
        "- cheap: ollama qwen3:8b",
        "- strong: anthropic claude-x",
        "Contents: skills 2, agents 1, hooks 0, commands 1, workflows 2",
      ].join("\n"),
    );
  });

  it("says why a playbook that does not load shows nothing", () => {
    const refused: LoadedPlaybook = {
      ...LOADED,
      playbook: null,
      topology: null,
      findings: [{ path: "nodes[0]", message: "unknown kind" }],
    };
    expect(showLine(refused, "en")).toBe("The playbook in /pb/spectro does not load: nodes[0]: unknown kind");
  });

  it("speaks German", () => {
    const lines = showLine(LOADED, "de").split("\n");
    expect(lines[0]).toBe("Playbook spectro");
    expect(lines).toContain("Schritte:");
    expect(lines).toContain("Prüfungen:");
    expect(lines).toContain("Modelle:");
    expect(lines).toContain("Inhalte: Skills 2, Agenten 1, Hooks 0, Befehle 1, Workflows 2");
  });

  it("shows the named playbook, else the current one, else says there is none", () => {
    expect(showTarget("Team X", NAMED, currentOf(null, "/pb/spectro"), "en")).toEqual({
      dir: "/home/team-x",
    });
    expect(showTarget("", NAMED, currentOf(null, "/pb/spectro"), "en")).toEqual({ dir: "/pb/spectro" });
    expect(showTarget("", NAMED, currentOf({ dir: "/pb/x", name: null, found: false }, null), "en")).toEqual({
      dir: "/pb/x",
    });
    expect(showTarget("", NAMED, currentOf(null, null), "en")).toEqual({
      refusal:
        "No playbook to show: this session has none. Pick one in the header dropdown in developer mode, or with /playbook use <name>.",
    });
    expect(showTarget("nope", NAMED, currentOf(null, null), "en")).toHaveProperty("refusal");
  });
});

describe("what the commands read from the server", () => {
  it("reads the registered folders and the pin of the workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ folders: ["/pb/a", 3, "/pb/b"], active: "/pb/b" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await readFolders("/ws one")).toEqual({ folders: ["/pb/a", "/pb/b"], pinned: "/pb/b" });
    expect(fetchMock).toHaveBeenCalledWith("/api/playbooks?workspace=%2Fws%20one");
    expect(await readFolders(null)).toEqual({ folders: ["/pb/a", "/pb/b"], pinned: null });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/playbooks");
  });

  it("reads one folder loaded, or the server's refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => LOADED })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ message: "Not a registered playbook folder: /x" }),
        }),
    );
    expect(await readLoaded("/pb/spectro", "/ws")).toEqual({ loaded: LOADED });
    expect(await readLoaded("/x", null)).toEqual({ error: "Not a registered playbook folder: /x" });
  });

  it("names each folder by its playbook, and a folder that does not load by nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("broken")
            ? { ok: false, status: 400, json: async () => ({}) }
            : { ok: true, json: async () => LOADED },
        ),
      ),
    );
    expect(await readNames(["/pb/spectro", "/pb/broken"], "/ws")).toEqual([
      { dir: "/pb/spectro", name: "spectro" },
      { dir: "/pb/broken", name: null },
    ]);
  });
});

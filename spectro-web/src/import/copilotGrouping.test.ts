// Card 605, task 12 item 1: a picked folder that has the layout of a GitHub
// Copilot session folder is recognised by its names alone, before a byte is
// read. The layouts below are the measured ones (2026-11-10, anonymised copies
// of an IDE export of 4 session folders and a CLI store of 40), with every
// folder name, pid and hash invented; only the file names and their places are
// the real ones.

import { describe, expect, it } from "vitest";
import { groupPickedFiles, type PickedFile } from "./claudeCodeRun";

/** Folders of a pick, each with the files it holds relative to itself. */
type Shape = [folder: string, files: string[]];

const pick = (root: string, shapes: Shape[]): PickedFile[] =>
  shapes.flatMap(([folder, files]) =>
    files.map((file) => ({
      name: file.slice(file.lastIndexOf("/") + 1),
      relativePath: `${root}/${folder}/${file}`,
    })),
  );

/** The IDE export: four session folders, three with a snapshot index, one in use. */
const IDE: Shape[] = [
  [
    "s01",
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "rewind-file-snapshots/backups/b1",
      "rewind-file-snapshots/backups/b2",
      "rewind-file-snapshots/index.json",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
  [
    "s02",
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "inuse.4002.lock",
      "rewind-file-snapshots/backups/b3",
      "rewind-file-snapshots/backups/b4",
      "rewind-file-snapshots/backups/b5",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
  [
    "s03",
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "rewind-file-snapshots/backups/b6",
      "rewind-file-snapshots/backups/b7",
      "rewind-file-snapshots/backups/b8",
      "rewind-file-snapshots/index.json",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
  [
    "s04",
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "rewind-file-snapshots/backups/b9",
      "rewind-file-snapshots/backups/b10",
      "rewind-file-snapshots/index.json",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
];

/** The CLI store: how many folders have each layout. */
const CLI_LAYOUTS: [count: number, files: string[]][] = [
  [12, [".workspace-fork.lock", "checkpoints/index.md", "events.jsonl", "workspace.yaml"]],
  [8, ["events.jsonl"]],
  [
    3,
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
  [11, ["events.jsonl", "inuse.<hold>.hold", "inuse.<pid>.lock"]],
  [2, [".workspace-fork.lock", "checkpoints/index.md", "workspace.yaml"]],
  [1, ["checkpoints/index.md", "events.jsonl", "session.db", "vscode.metadata.json", "workspace.yaml"]],
  [1, ["checkpoints/index.md", "events.jsonl", "session.db", "workspace.yaml"]],
  [
    1,
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "rewind-file-snapshots/backups/b1",
      "rewind-file-snapshots/index.json",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
  [
    1,
    [
      ".workspace-fork.lock",
      "checkpoints/index.md",
      "events.jsonl",
      "files/f1.py",
      "rewind-file-snapshots/index.json",
      "rewind-file-snapshots/tracking.json",
      "workspace.yaml",
    ],
  ],
];

/** The CLI store's 40 session folders plus the folder of operation locks beside them. */
function cliStore(): Shape[] {
  const shapes: Shape[] = [
    [".session-operation-locks", Array.from({ length: 39 }, (_, i) => `l${String(i).padStart(2, "0")}.lock`)],
  ];
  let n = 0;
  for (const [count, files] of CLI_LAYOUTS) {
    for (let i = 0; i < count; i++) {
      n++;
      const folder = `c${String(n).padStart(2, "0")}`;
      shapes.push([
        folder,
        files.map((f) => f.replace("<pid>", String(4000 + n)).replace("<hold>", String(5000 + n))),
      ]);
    }
  }
  return shapes;
}

const nameAt = (files: PickedFile[], i: number | null): string | null =>
  i === null ? null : files[i].relativePath;

describe("a Copilot session folder is recognised by its layout", () => {
  it("one IDE session folder gives its events, workspace and snapshot index", () => {
    // The person picked the session folder itself, so its name leads every path.
    const files = IDE[0][1].map((file) => ({
      name: file.slice(file.lastIndexOf("/") + 1),
      relativePath: `s01/${file}`,
    }));
    const group = groupPickedFiles(files);
    expect(group.kind).toBe("copilot");
    if (group.kind !== "copilot") return;
    expect(nameAt(files, group.session.events)).toBe("s01/events.jsonl");
    expect(nameAt(files, group.session.workspace)).toBe("s01/workspace.yaml");
    expect(nameAt(files, group.session.snapshots)).toBe("s01/rewind-file-snapshots/index.json");
    expect(group.session.live).toBe(false);
    expect(group.session.folder).toBe("s01");
  });

  it("a session folder in use says so, from the lock beside its events", () => {
    const files = pick("ide", [IDE[1]]);
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot") throw new Error(`expected copilot, got ${group.kind}`);
    expect(group.session.live).toBe(true);
    // This folder has a tracking file and backups but no index.
    expect(group.session.snapshots).toBeNull();
  });

  it("one CLI folder with a workspace and checkpoints has no snapshot index", () => {
    const files = pick("session-state", [["c01", CLI_LAYOUTS[0][1]]]);
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot") throw new Error(`expected copilot, got ${group.kind}`);
    expect(nameAt(files, group.session.events)).toBe("session-state/c01/events.jsonl");
    expect(nameAt(files, group.session.workspace)).toBe("session-state/c01/workspace.yaml");
    expect(group.session.snapshots).toBeNull();
    expect(group.session.live).toBe(false);
  });

  it("each mark alone is enough beside events.jsonl", () => {
    for (const mark of ["workspace.yaml", "rewind-file-snapshots/tracking.json", "checkpoints/index.md"]) {
      const group = groupPickedFiles(pick("x", [["one", ["events.jsonl", mark]]]));
      expect(group.kind, mark).toBe("copilot");
    }
  });

  it("the IDE export of 4 is a store of 4, newest first is the dialog's job", () => {
    const files = pick("gh_copilot", IDE);
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot-store") throw new Error(`expected copilot-store, got ${group.kind}`);
    expect(group.sessions.map((s) => s.folder)).toEqual([
      "gh_copilot/s01",
      "gh_copilot/s02",
      "gh_copilot/s03",
      "gh_copilot/s04",
    ]);
    expect(group.skipped).toBe(0);
    expect(group.sessions.filter((s) => s.snapshots !== null)).toHaveLength(3);
    expect(group.sessions.filter((s) => s.live)).toHaveLength(1);
    for (const s of group.sessions) {
      expect(nameAt(files, s.events)).toBe(`${s.folder}/events.jsonl`);
      expect(nameAt(files, s.workspace)).toBe(`${s.folder}/workspace.yaml`);
    }
  });

  it("the CLI store of 40 lists the 38 with events and counts the 2 without", () => {
    const files = pick("session-state", cliStore());
    expect(files).toHaveLength(172);
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot-store") throw new Error(`expected copilot-store, got ${group.kind}`);
    expect(group.sessions).toHaveLength(38);
    expect(group.skipped).toBe(2);
    // The folder of operation locks is no session folder and is not counted.
    expect(group.sessions.some((s) => s.folder.includes(".session-operation-locks"))).toBe(false);
    expect(group.sessions.filter((s) => s.live)).toHaveLength(11);
    expect(group.sessions.filter((s) => s.workspace !== null)).toHaveLength(19);
    expect(group.sessions.filter((s) => s.snapshots !== null)).toHaveLength(2);
    // A folder that holds only events.jsonl is listed in a store.
    const bare = group.sessions.find((s) => s.folder === "session-state/c13");
    expect(bare).toEqual({
      folder: "session-state/c13",
      events: files.findIndex((f) => f.relativePath === "session-state/c13/events.jsonl"),
      workspace: null,
      snapshots: null,
      live: false,
    });
  });

  it("reads nothing under files/, research/ or the backups, and never a lock or a database", () => {
    const files = pick("session-state", cliStore());
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot-store") throw new Error("expected copilot-store");
    const named = new Set<number>();
    for (const s of group.sessions) {
      for (const i of [s.events, s.workspace, s.snapshots]) if (i !== null) named.add(i);
    }
    for (const i of named) {
      expect(files[i].name, files[i].relativePath).toMatch(/^(?:events\.jsonl|workspace\.yaml|index\.json)$/);
    }
  });

  it("an events.jsonl inside a session's files/ folder is not a second session", () => {
    const files = pick("x", [
      ["one", ["events.jsonl", "workspace.yaml", "files/sub/events.jsonl", "files/sub/workspace.yaml"]],
    ]);
    const group = groupPickedFiles(files);
    if (group.kind !== "copilot") throw new Error(`expected copilot, got ${group.kind}`);
    expect(nameAt(files, group.session.events)).toBe("x/one/events.jsonl");
  });
});

describe("everything that is not this layout keeps today's grouping", () => {
  it("a Claude Code project folder still groups as a run", () => {
    const group = groupPickedFiles([
      { name: "sess.jsonl", relativePath: "proj/sess.jsonl" },
      { name: "agent-a.jsonl", relativePath: "proj/sess/subagents/agent-a.jsonl" },
      { name: "agent-a.meta.json", relativePath: "proj/sess/subagents/agent-a.meta.json" },
    ]);
    expect(group).toEqual({
      kind: "run",
      session: 0,
      sidecars: [{ jsonl: 1, meta: 2, runId: null }],
      runStates: [],
    });
  });

  it("a CLI folder of events.jsonl and its locks alone has no mark, and loads as a run", () => {
    const files = pick("session-state", [["c20", ["events.jsonl", "inuse.5020.hold", "inuse.4020.lock"]]]);
    expect(groupPickedFiles(files)).toEqual({ kind: "run", session: 0, sidecars: [], runStates: [] });
  });

  it("folders of events.jsonl without any mark keep the several-sessions message", () => {
    const files = pick("s", [
      ["a", ["events.jsonl"]],
      ["b", ["events.jsonl"]],
    ]);
    expect(groupPickedFiles(files)).toEqual({ kind: "many", count: 2 });
  });

  it("a mark without events.jsonl beside it is no session folder", () => {
    const files = pick("s", [["a", ["workspace.yaml", "checkpoints/index.md"]]]);
    expect(groupPickedFiles(files)).toEqual({ kind: "none" });
  });

  it("one file alone is still a single file, whatever its name", () => {
    expect(groupPickedFiles([{ name: "events.jsonl", relativePath: "" }])).toEqual({
      kind: "single",
      session: 0,
    });
  });
});

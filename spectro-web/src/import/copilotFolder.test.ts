// Card 605, task 12: a Copilot session folder loads as a whole. Every fixture
// is invented, with paths under /w; the shapes are those of the anonymised
// copies measured on 2026-11-10.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PickedCopilotFolder } from "./claudeCodeRun";
import type { RunEvent } from "../events";
import { detectAndLoad } from "./detect";
import {
  copilotSideFile,
  copilotStoreRows,
  copilotWorkspace,
  loadCopilotFolder,
  loadEvents,
  pickedAlone,
  pickedOnItsOwn,
  placeSnapshots,
  readCopilotFolder,
  readSnapshotIndex,
  readWorkspaceYaml,
  replacesShown,
  type PickedText,
} from "./copilotFolder";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const IDE = fixture("copilot-ide.jsonl");
const CLAUDE = fixture("cc-linear.jsonl");

/** A picked file that counts its reads. */
function file(name: string, body: string | Error): PickedText & { reads: number } {
  const f = {
    name,
    reads: 0,
    text: (): Promise<string> => {
      f.reads++;
      return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
    },
  };
  return f;
}

const folder = (over: Partial<PickedCopilotFolder> = {}): PickedCopilotFolder => ({
  folder: "s01",
  events: 0,
  workspace: null,
  snapshots: null,
  live: false,
  ...over,
});

describe("reading a Copilot session folder (item 1)", () => {
  it("reads events.jsonl and the side files the grouping named, nothing else", async () => {
    const files = [
      file("events.jsonl", IDE),
      file("workspace.yaml", "name: x\n"),
      file("index.json", '{"schema":1,"snapshots":[]}'),
      file("tracking.json", '{"schema":1,"tracking":true}'),
      file("b1", "content of a backup"),
    ];
    const texts = await readCopilotFolder(files, folder({ workspace: 1, snapshots: 2, live: true }));
    expect(texts).toEqual({
      events: IDE,
      workspace: "name: x\n",
      snapshots: '{"schema":1,"snapshots":[]}',
      live: true,
    });
    expect(files.map((f) => f.reads)).toEqual([1, 1, 1, 0, 0]);
  });

  it("a side file that cannot be read is left out, and the session still loads", async () => {
    const files = [file("events.jsonl", IDE), file("workspace.yaml", new Error("gone"))];
    const texts = await readCopilotFolder(files, folder({ workspace: 1 }));
    expect(texts.workspace).toBeNull();
    expect(loadCopilotFolder(texts).kind).toBe("vscode-agent");
  });

  it("an events.jsonl that cannot be read fails the load", async () => {
    await expect(readCopilotFolder([file("events.jsonl", new Error("gone"))], folder())).rejects.toThrow(
      "gone",
    );
  });
});

describe("loading a Copilot session folder (item 1)", () => {
  it("loads the Copilot session with the run summary of its workspace", () => {
    const got = loadCopilotFolder({ events: IDE, workspace: null, snapshots: null, live: false });
    expect(got.kind).toBe("vscode-agent");
    expect(got.label).toBe("events.jsonl");
    expect(got.run).toEqual({
      workspace: "/w",
      childrenMerged: 0,
      childrenSkipped: 0,
      childrenUnrecorded: 0,
    });
    expect(got.events.length).toBeGreaterThan(0);
    expect(got.source.origin.length).toBe(got.events.length);
  });

  it("the content check decides: a Claude Code transcript in the folder loads as one", () => {
    const got = loadCopilotFolder({ events: CLAUDE, workspace: "name: x\n", snapshots: null, live: true });
    expect(got.kind).toBe("claude-code");
  });

  it("an events.jsonl the importer does not read fails as it does today", () => {
    expect(() =>
      loadCopilotFolder({ events: "not json\n", workspace: null, snapshots: null, live: false }),
    ).toThrow("invalid JSONL");
  });
});

// ---- item 2: workspace.yaml ----------------------------------------------------

const YAML = [
  "id: s-ide",
  "cwd: /w",
  "client_name: copilot-intellij",
  "name: Rename the loader",
  "user_named: false",
  "summary_count: 0",
  "# a comment line",
  "",
  "created_at: 2026-11-10T08:00:00.000Z",
  "updated_at: 2026-11-10T08:05:00.000Z",
].join("\n");

describe("reading workspace.yaml (item 2)", () => {
  it("reads flat key: value lines, plain and quoted", () => {
    expect(
      readWorkspaceYaml(
        [
          "id: s-1",
          'name: "say \\"hi\\" there"',
          "cwd: '/w/it''s here'",
          "client_name: github/cli",
          "summary_count: 0",
          "branch: main # the branch",
        ].join("\n"),
      ),
    ).toEqual({
      id: "s-1",
      name: 'say "hi" there',
      cwd: "/w/it's here",
      client_name: "github/cli",
      summary_count: "0",
      branch: "main",
    });
  });

  it("skips what is not a quoted or plain scalar, and never evaluates it", () => {
    const read = readWorkspaceYaml(
      [
        "name: [x]",
        "a: !tag",
        "b: !!str y",
        "c: {k: v}",
        "d: &anchor z",
        "e: *anchor",
        "f: |",
        "  block text",
        "g: >",
        "h:",
        "i: ~",
        "j: null",
        "  k: nested",
        "- item",
        "l: 'unclosed",
        'm: "unclosed',
        "n: a: b",
        "o: @at",
        "p: `tick",
        "q: %pct",
      ].join("\n"),
    );
    expect(read).toEqual({});
  });

  it("keeps the first of a key named twice and reads CRLF lines", () => {
    expect(readWorkspaceYaml("name: one\r\nname: two\r\ncwd: /w\r\n")).toEqual({ name: "one", cwd: "/w" });
  });

  it("names what the import uses, and only that", () => {
    expect(copilotWorkspace(readWorkspaceYaml(YAML))).toEqual({
      name: "Rename the loader",
      cwd: "/w",
      client: "copilot-intellij",
      createdAt: "2026-11-10T08:00:00.000Z",
    });
    expect(copilotWorkspace(readWorkspaceYaml("name: \ncwd: relative/path\n"))).toEqual({
      name: null,
      cwd: null,
      client: null,
      createdAt: null,
    });
  });
});

/** The IDE fixture without the folder its session.start names. */
const IDE_NO_CWD = IDE.replace('"context":{"cwd":"/w"}', '"context":{}');

describe("a folder load uses workspace.yaml (item 2)", () => {
  it("the name becomes the import's title", () => {
    const got = loadCopilotFolder({ events: IDE, workspace: YAML, snapshots: null, live: false });
    expect(got.label).toBe("Rename the loader");
    expect(got.source.copilot?.workspace).toEqual({
      name: "Rename the loader",
      cwd: "/w",
      client: "copilot-intellij",
      createdAt: "2026-11-10T08:00:00.000Z",
    });
  });

  it("an empty name keeps the title of today", () => {
    const got = loadCopilotFolder({
      events: IDE,
      workspace: YAML.replace("name: Rename the loader", "name: ''"),
      snapshots: null,
      live: false,
    });
    expect(got.label).toBe("events.jsonl");
  });

  it("the cwd is the workspace when session.start names none", () => {
    expect(IDE_NO_CWD).not.toBe(IDE);
    const got = loadCopilotFolder({
      events: IDE_NO_CWD,
      workspace: YAML.replace("cwd: /w", "cwd: /w/elsewhere"),
      snapshots: null,
      live: false,
    });
    expect(got.events[0]).toMatchObject({ type: "ground_info", cwd: "/w/elsewhere" });
    // The frame is the importer's own, not a line of the file.
    expect(got.source.origin[0]).toBe(-1);
    expect(got.source.origin.length).toBe(got.events.length);
    expect(got.run.workspace).toBe("/w/elsewhere");
  });

  it("session.start's own folder stays first", () => {
    const got = loadCopilotFolder({
      events: IDE,
      workspace: YAML.replace("cwd: /w", "cwd: /w/elsewhere"),
      snapshots: null,
      live: false,
    });
    const grounds = got.events.filter((e) => (e as { type: string }).type === "ground_info");
    expect(grounds).toEqual([expect.objectContaining({ cwd: "/w" })]);
    expect(got.run.workspace).toBe("/w");
  });

  it("an events.jsonl that is no Copilot session loads without the side files", () => {
    const old = fixture("vscode-agent.jsonl");
    const got = loadCopilotFolder({ events: old, workspace: YAML, snapshots: null, live: true });
    expect(got.kind).toBe("vscode-agent");
    expect(got.label).toBe("events.jsonl");
    expect(got.source.copilot).toBeUndefined();
    const claude = loadCopilotFolder({ events: CLAUDE, workspace: YAML, snapshots: null, live: true });
    expect(claude.label).toBe("events.jsonl");
    expect(claude.source.copilot).toBeUndefined();
  });
});

describe("the importer marks a Copilot session by its producer", () => {
  it("carries the session id of session.start beside the events", () => {
    expect(detectAndLoad(IDE).source.copilot).toEqual({ sessionId: "s-ide" });
    expect(detectAndLoad(IDE.replace('"sessionId":"s-ide",', "")).source.copilot).toEqual({
      sessionId: null,
    });
  });

  it("marks nothing for a file the producer does not name", () => {
    expect(detectAndLoad(fixture("vscode-agent.jsonl")).source.copilot).toBeUndefined();
    expect(detectAndLoad(CLAUDE).source.copilot).toBeUndefined();
  });
});

// ---- item 3: the file snapshots ----------------------------------------------------

const FOLDER_EVENTS = fixture("copilot-folder/events.jsonl");
const FOLDER_YAML = fixture("copilot-folder/workspace.yaml");
const FOLDER_INDEX = fixture("copilot-folder/rewind-file-snapshots/index.json");

/** The root run_starts of a stream, by event index. */
const rootsOf = (events: readonly { type: string; parentId?: unknown }[]): number[] =>
  events.flatMap((e, i) => (e.type === "run_start" && e.parentId === undefined ? [i] : []));

describe("reading rewind-file-snapshots/index.json (item 3)", () => {
  it("gives each snapshot's files: created, changed or deleted, with their lines", () => {
    const read = readSnapshotIndex(FOLDER_INDEX);
    expect(read).toEqual([
      {
        eventId: "u1",
        agentId: "main",
        files: [
          { path: "/w/src/parser.ts", kind: "change", added: 3, removed: 1 },
          { path: "/w/test/parser.test.ts", kind: "create", added: 12, removed: 0 },
          { path: "/w/old/notes.txt", kind: "delete", added: 0, removed: 4 },
        ],
      },
      {
        eventId: "u2",
        agentId: "main",
        files: [
          { path: "/w/.env", kind: "change", added: 1, removed: 1 },
          { path: "/srv/shared/settings.md", kind: "change", added: 2, removed: 2 },
        ],
      },
    ]);
  });

  it("an image without content, or none at all, holds no content", () => {
    const one = (pre: unknown, post: unknown) =>
      readSnapshotIndex(
        JSON.stringify({
          schema: 1,
          snapshots: [{ eventId: "e", files: { k: { path: "/w/a", preimage: pre, postimage: post } } }],
        }),
      )?.[0].files[0].kind;
    const content = { kind: "content", contentHash: "h" };
    expect(one(content, content)).toBe("change");
    expect(one(undefined, content)).toBe("create");
    expect(one(null, content)).toBe("create");
    expect(one({ kind: "lorem" }, content)).toBe("create");
    expect(one(content, undefined)).toBe("delete");
    expect(one(content, { kind: "lorem" })).toBe("delete");
    // Nothing before and nothing after: the file does not stand at the end.
    expect(one({ kind: "lorem" }, { kind: "lorem" })).toBe("delete");
  });

  it("takes resolvedPath when path is missing, names the record's agent, and keeps lines finite", () => {
    const read = readSnapshotIndex(
      JSON.stringify({
        schema: 1,
        snapshots: [
          {
            eventId: "e",
            agentId: "a-lex",
            files: {
              k: {
                preimage: { kind: "content", resolvedPath: "/w/from-pre" },
                postimage: { kind: "content" },
                linesAdded: -3,
                linesRemoved: "7",
              },
              nopath: { preimage: { kind: "content" }, postimage: { kind: "content" } },
            },
          },
          { files: {} },
        ],
      }),
    );
    expect(read).toEqual([
      {
        eventId: "e",
        agentId: "a-lex",
        files: [{ path: "/w/from-pre", kind: "change", added: 0, removed: 0 }],
      },
      { eventId: null, agentId: "main", files: [] },
    ]);
  });

  it("a file that is no snapshot index gives none", () => {
    expect(readSnapshotIndex('{"schema":1,"tracking":true}')).toBeNull();
    expect(readSnapshotIndex('{"snapshots":[]}')).toBeNull();
    expect(readSnapshotIndex("[1,2]")).toBeNull();
    expect(readSnapshotIndex("not json")).toBeNull();
    expect(readSnapshotIndex('{"schema":1,"k13":{},"snapshots":[]}')).toEqual([]);
  });
});

describe("a snapshot belongs to the run its user.message opened (item 3)", () => {
  it("stands at the end of that run, on the main agent", () => {
    const got = loadCopilotFolder({
      events: FOLDER_EVENTS,
      workspace: FOLDER_YAML,
      snapshots: FOLDER_INDEX,
      live: false,
    });
    const roots = rootsOf(got.events as unknown as { type: string; parentId?: unknown }[]);
    expect(roots).toHaveLength(2);
    const placed = got.source.copilot?.snapshots;
    expect(placed?.map((s) => ({ from: s.from, at: s.at, agentId: s.agentId }))).toEqual([
      { from: roots[0], at: roots[1] - 1, agentId: "main" },
      { from: roots[1], at: got.events.length - 1, agentId: "main" },
    ]);
    expect(placed?.[0].files.map((f) => f.kind)).toEqual(["change", "create", "delete"]);
  });

  it("a snapshot whose eventId opened no run stands at the end of the session", () => {
    const index = FOLDER_INDEX.replace('"eventId": "u2"', '"eventId": "not-a-message"');
    const got = loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: index, live: false });
    expect(got.source.copilot?.snapshots?.[1]).toMatchObject({ from: null, at: got.events.length - 1 });
  });

  it("a folder without an index, or with an index of no snapshots, carries none", () => {
    const none = loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: null, live: false });
    expect(none.source.copilot?.snapshots).toBeUndefined();
    const empty = loadCopilotFolder({
      events: FOLDER_EVENTS,
      workspace: null,
      snapshots: '{"schema":1,"snapshots":[]}',
      live: false,
    });
    expect(empty.source.copilot?.snapshots).toBeUndefined();
  });

  it("the snapshots stay beside the stream: no frame carries them", () => {
    const got = loadCopilotFolder({
      events: FOLDER_EVENTS,
      workspace: null,
      snapshots: FOLDER_INDEX,
      live: false,
    });
    const plain = loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: null, live: false });
    expect(got.events).toEqual(plain.events);
    expect(JSON.stringify(got.events)).not.toContain("parser.test.ts");
  });
});

describe("a child's run does not end the run its parent's message opened (item 3)", () => {
  it("places the snapshot before the next root run_start, past the child's", () => {
    const lines = [
      JSON.stringify({ type: "user.message", id: "u1" }),
      JSON.stringify({ type: "subagent.started", id: "x1" }),
      JSON.stringify({ type: "user.message", id: "u2" }),
    ];
    const events = [
      { type: "run_start", runId: "r", agentId: "main", prompt: "a", ts: 1 },
      { type: "run_start", runId: "c", agentId: "kid", parentId: "main", prompt: "t", ts: 2 },
      { type: "text_delta", agentId: "kid", text: "x", ts: 3 },
      { type: "run_start", runId: "r", agentId: "main", prompt: "b", ts: 4 },
      { type: "run_end", runId: "r", stopReason: "end_turn", ts: 5 },
    ] as unknown as RunEvent[];
    const placed = placeSnapshots(
      [
        { eventId: "u1", agentId: "main", files: [] },
        { eventId: "u2", agentId: "main", files: [] },
      ],
      events,
      { lines, origin: Int32Array.from([0, 1, 1, 2, -1]) },
    );
    expect(placed.map((p) => [p.from, p.at])).toEqual([
      [0, 2],
      [3, 4],
    ]);
  });
});

// ---- item 4: a live session ---------------------------------------------------------

describe("a session folder in use says how much it held (item 4)", () => {
  it("counts the records written up to the pick", () => {
    const got = loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: null, live: true });
    expect(got.source.copilot?.live).toEqual({ records: 12 });
    // Blank lines are no records.
    const gappy = loadCopilotFolder({
      events: FOLDER_EVENTS.replace("\n", "\n\n"),
      workspace: null,
      snapshots: null,
      live: true,
    });
    expect(gappy.source.copilot?.live).toEqual({ records: 12 });
  });

  it("says nothing of the kind without the lock", () => {
    const got = loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: null, live: false });
    expect(got.source.copilot?.live).toBeUndefined();
  });
});

// ---- item 5: a store -----------------------------------------------------------------

/** A picked file with a size and a time, that counts its reads. */
function info(name: string, body: string, size = body.length, lastModified = 0) {
  return Object.assign(file(name, body), { size, lastModified });
}

describe("the rows of a Copilot store (item 5)", () => {
  const sessions: PickedCopilotFolder[] = [
    { folder: "st/a", events: 0, workspace: 1, snapshots: null, live: false },
    { folder: "st/b", events: 2, workspace: null, snapshots: null, live: true },
    { folder: "st/c", events: 3, workspace: 4, snapshots: 5, live: false },
  ];
  const files = () => [
    info("events.jsonl", "a", 2048, Date.parse("2026-11-01T00:00:00.000Z")),
    info(
      "workspace.yaml",
      "name: Older one\nclient_name: github/cli\ncreated_at: 2026-11-02T10:00:00.000Z\n",
    ),
    info("events.jsonl", "b", 900, Date.parse("2026-11-05T00:00:00.000Z")),
    info("events.jsonl", "c", 5000, Date.parse("2026-11-01T00:00:00.000Z")),
    info("workspace.yaml", "name: ''\nclient_name: copilot-intellij\ncreated_at: 2026-11-04T09:00:00.000Z\n"),
    info("index.json", '{"schema":1,"snapshots":[]}'),
  ];

  it("lists one row per session folder, newest first, from workspace.yaml and the File alone", async () => {
    const picked = files();
    const rows = await copilotStoreRows(picked, sessions);
    expect(rows).toEqual([
      {
        session: 1,
        name: null,
        created: Date.parse("2026-11-05T00:00:00.000Z"),
        client: null,
        bytes: 900,
        live: true,
      },
      {
        session: 2,
        name: null,
        created: Date.parse("2026-11-04T09:00:00.000Z"),
        client: "copilot-intellij",
        bytes: 5000,
        live: false,
      },
      {
        session: 0,
        name: "Older one",
        created: Date.parse("2026-11-02T10:00:00.000Z"),
        client: "github/cli",
        bytes: 2048,
        live: false,
      },
    ]);
  });

  it("reads only the workspace.yaml files to build the list", async () => {
    const picked = files();
    await copilotStoreRows(picked, sessions);
    expect(picked.map((f) => f.reads)).toEqual([0, 1, 0, 0, 1, 0]);
  });

  it("a workspace.yaml that cannot be read or names no time falls back to the file's time", async () => {
    const picked = [
      info("events.jsonl", "a", 10, 1000),
      Object.assign(file("workspace.yaml", new Error("gone")), { size: 0, lastModified: 0 }),
      info("events.jsonl", "b", 10, 2000),
      info("workspace.yaml", "name: B\ncreated_at: soon\n"),
    ];
    const rows = await copilotStoreRows(picked, [
      { folder: "a", events: 0, workspace: 1, snapshots: null, live: false },
      { folder: "b", events: 2, workspace: 3, snapshots: null, live: false },
    ]);
    expect(rows.map((r) => [r.session, r.name, r.created])).toEqual([
      [1, "B", 2000],
      [0, null, 1000],
    ]);
  });
});

// ---- item 6: one file of a folder -------------------------------------------------------

describe("events.jsonl picked alone points at its folder (item 6)", () => {
  it("marks a Copilot session that arrived without its folder", () => {
    const { source } = detectAndLoad(FOLDER_EVENTS);
    expect(pickedAlone(source).copilot).toEqual({ sessionId: "s-folder", alone: true });
    // Nothing else of the source changes.
    expect({ ...pickedAlone(source), copilot: source.copilot }).toEqual(source);
  });

  it("marks nothing for a file that is no Copilot session", () => {
    const { source } = detectAndLoad(CLAUDE);
    expect(pickedAlone(source)).toBe(source);
    expect(pickedAlone(detectAndLoad(fixture("vscode-agent.jsonl")).source).copilot).toBeUndefined();
  });

  it("a folder pick replaces the shown session only when its session id is the same", () => {
    const folder = loadCopilotFolder({
      events: FOLDER_EVENTS,
      workspace: FOLDER_YAML,
      snapshots: null,
      live: false,
    });
    expect(replacesShown(folder.source, "s-folder")).toBe(true);
    expect(replacesShown(folder.source, "s-other")).toBe(false);
    expect(replacesShown(folder.source, null)).toBe(false);
    expect(replacesShown(folder.source, undefined)).toBe(false);
    const noId = loadCopilotFolder({
      events: FOLDER_EVENTS.replace('"sessionId":"s-folder",', ""),
      workspace: null,
      snapshots: null,
      live: false,
    });
    expect(noId.source.copilot?.sessionId).toBeNull();
    expect(replacesShown(noId.source, null)).toBe(false);
    expect(replacesShown(detectAndLoad(CLAUDE).source, "s-folder")).toBe(false);
  });
});

// ---- item 7: a side file alone ------------------------------------------------------------

describe("a side file of a Copilot folder picked alone is named as one (item 7)", () => {
  it("knows workspace.yaml, the snapshot index, the tracking file and the checkpoint list", () => {
    expect(copilotSideFile("workspace.yaml", FOLDER_YAML)).toBe(true);
    expect(copilotSideFile("index.json", FOLDER_INDEX)).toBe(true);
    // The two JSON files are known by their keys, whatever their name.
    expect(copilotSideFile("copy.json", '{"schema":1,"snapshots":[]}')).toBe(true);
    expect(copilotSideFile("tracking.json", '{\n  "schema": 1,\n  "tracking": true\n}')).toBe(true);
    expect(copilotSideFile("index.md", "# Checkpoints\n\n| 0 | a checkpoint |\n")).toBe(true);
  });

  it("names nothing else a side file", () => {
    expect(copilotSideFile("events.jsonl", FOLDER_EVENTS)).toBe(false);
    expect(copilotSideFile("index.md", "# Notes\n\nnothing here\n")).toBe(false);
    expect(copilotSideFile("index.json", '{"schema":1}')).toBe(false);
    expect(copilotSideFile("index.json", '{"snapshots":[]}')).toBe(false);
    expect(copilotSideFile("other.yaml", "name: x\n")).toBe(false);
    expect(copilotSideFile("index.json", "not json")).toBe(false);
  });
});

// ---- fix round 1, item 2 (review I2) ----------------------------------------------------

describe("a folder pick that holds only events.jsonl is a folder pick (fix round 1 item 2)", () => {
  it("only a file picked without a folder path counts as picked alone", () => {
    expect(pickedOnItsOwn({ webkitRelativePath: "" })).toBe(true);
    expect(pickedOnItsOwn({})).toBe(true);
    expect(pickedOnItsOwn({ webkitRelativePath: "c13/events.jsonl" })).toBe(false);
  });
});

// ---- fix round 1, item 5 (review M1) ------------------------------------------------------

describe("a half-written last line is left out (fix round 1 item 5)", () => {
  const lastLine = FOLDER_EVENTS.trimEnd().split("\n").pop() ?? "";
  const torn = `${FOLDER_EVENTS.trimEnd()}\n${lastLine.slice(0, 40)}`;

  it("a folder loads without it, counts only the whole records and says so", () => {
    expect(() => detectAndLoad(torn)).toThrow("invalid JSONL");
    const got = loadCopilotFolder({ events: torn, workspace: null, snapshots: null, live: true });
    expect(got.kind).toBe("vscode-agent");
    expect(got.source.copilot?.live).toEqual({ records: 12 });
    expect(got.source.copilot?.torn).toBe(true);
    expect(got.events).toEqual(
      loadCopilotFolder({ events: FOLDER_EVENTS, workspace: null, snapshots: null, live: true }).events,
    );
  });

  it("a lone file of a Copilot session loads the same way", () => {
    const got = loadEvents(torn);
    expect(got.source.copilot).toEqual({ sessionId: "s-folder", torn: true });
    expect(loadEvents(FOLDER_EVENTS).source.copilot).toEqual({ sessionId: "s-folder" });
  });

  it("any other line that does not parse still fails as today", () => {
    const lines = FOLDER_EVENTS.trimEnd().split("\n");
    lines[3] = lines[3].slice(0, 30);
    expect(() => loadEvents(lines.join("\n"))).toThrow("invalid JSONL");
    // A torn middle line beside a torn last line fails too.
    expect(() => loadEvents(`${lines.join("\n")}\n{"type":"user.mess`)).toThrow("invalid JSONL");
    expect(() =>
      loadCopilotFolder({ events: lines.join("\n"), workspace: null, snapshots: null, live: true }),
    ).toThrow("invalid JSONL");
  });

  it("a torn last line of a file that is no Copilot session fails as today", () => {
    const claudeTorn = `${CLAUDE.trimEnd()}\n{"type":"user","mess`;
    expect(() => loadEvents(claudeTorn)).toThrow("invalid JSONL");
  });
});

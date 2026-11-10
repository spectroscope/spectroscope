// Card 605, task 12: a Copilot session folder loads as a whole. Every fixture
// is invented, with paths under /w; the shapes are those of the anonymised
// copies measured on 2026-11-10.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PickedCopilotFolder } from "./claudeCodeRun";
import { detectAndLoad } from "./detect";
import {
  copilotWorkspace,
  loadCopilotFolder,
  readCopilotFolder,
  readWorkspaceYaml,
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

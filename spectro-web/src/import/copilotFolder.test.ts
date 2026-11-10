// Card 605, task 12: a Copilot session folder loads as a whole. Every fixture
// is invented, with paths under /w; the shapes are those of the anonymised
// copies measured on 2026-11-10.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PickedCopilotFolder } from "./claudeCodeRun";
import { loadCopilotFolder, readCopilotFolder, type PickedText } from "./copilotFolder";

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

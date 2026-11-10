// Card 605, task 12 item 3: the file snapshots of a Copilot session folder
// reach the files tab and the report, beside the stream and never in it. The
// folder is invented (import/fixtures/copilot-folder), with paths under /w and
// one file outside it.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { chatToHtml, textFeedToHtml } from "../export/html";
import { toJsonl } from "../export/jsonl";
import { toVscodeAgentJsonl } from "../export/vscodeAgent";
import { loadCopilotFolder, type CopilotSnapshot } from "../import/copilotFolder";
import events from "../import/fixtures/copilot-folder/events.jsonl?raw";
import index from "../import/fixtures/copilot-folder/rewind-file-snapshots/index.json?raw";
import workspace from "../import/fixtures/copilot-folder/workspace.yaml?raw";
import { replayComposer } from "../state/sessionRows";
import { FilesDetail } from "./FilesDetail";
import { FilesOperations } from "./FilesOperations";
import { COPILOT_SNAPSHOT_TOOL, fileRows, foldFiles, type FileCall } from "./fold";
import { buildReport } from "./report";
import { reportCsv } from "./reportCsv";
import { reportHtml } from "./reportHtml";

const loaded = loadCopilotFolder({ events, workspace, snapshots: index, live: false });
const stream = loaded.events;
const snapshots = loaded.source.copilot?.snapshots ?? [];
const ledger = foldFiles(stream, snapshots);
const shots = ledger.calls.filter((c) => c.snapshot !== undefined);

const report = (withSnapshots = true) =>
  buildReport({
    events: stream,
    ledger: withSnapshots ? ledger : foldFiles(stream),
    sessionId: "import:vscode-agent:Parser test",
    title: "Parser test",
    version: null,
    now: Date.parse("2026-11-10T10:00:00.000Z"),
  });

const ordinals = new Map(ledger.calls.map((c, i) => [c.callIndex, i + 1]));

describe("a snapshot is a recorded entry of the files tab (item 3)", () => {
  it("gives one call per snapshot at the end of its run, on the main agent", () => {
    expect(snapshots).toHaveLength(2);
    expect(shots.map((c) => c.callIndex)).toEqual(snapshots.map((s) => s.at));
    for (const c of shots) {
      expect(c.tool).toBe(COPILOT_SNAPSHOT_TOOL);
      expect(c.agentId).toBe("main");
      expect(c.status).toBe("ok");
      expect(c.shell).toBe(false);
      expect(c.touches.every((t) => t.sources.length === 1 && t.sources[0] === "recorded")).toBe(true);
    }
    expect(shots.map((c) => [c.line, c.snapshot])).toEqual([
      ["+15 −5", { added: 15, removed: 5 }],
      ["+3 −3", { added: 3, removed: 3 }],
    ]);
  });

  it("names each file with what happened to it and its lines", () => {
    expect(shots[0].touches.map((t) => [t.path, t.kind, t.lines])).toEqual([
      ["/w/src/parser.ts", "change", { added: 3, removed: 1 }],
      ["/w/test/parser.test.ts", "create", { added: 12, removed: 0 }],
      ["/w/old/notes.txt", "delete", { added: 0, removed: 4 }],
    ]);
    const rows = fileRows(ledger, null);
    const letter = (path: string) => rows.find((r) => r.path === path)?.letter;
    // parser.ts was read by a view first and changed by the snapshot.
    expect([
      letter("/w/src/parser.ts"),
      letter("/w/test/parser.test.ts"),
      letter("/w/old/notes.txt"),
    ]).toEqual(["M", "A", "D"]);
  });

  it("keeps the ledger in event order, with the time of the run's end", () => {
    const at = ledger.calls.map((c) => c.callIndex);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(shots[1].t).toBe(13);
  });

  it("steps back to a free event when a file call stands on the run's end", () => {
    const view = ledger.calls.find((c) => c.tool === "view");
    if (view === undefined) throw new Error("no view call");
    const onIt: CopilotSnapshot = {
      from: 0,
      at: view.callIndex,
      agentId: "main",
      files: [{ path: "/w/x.ts", kind: "change", added: 1, removed: 0 }],
    };
    const calls = foldFiles(stream, [onIt]).calls;
    expect(calls.map((c) => c.callIndex)).toEqual([view.callIndex - 1, view.callIndex]);
    expect(new Set(calls.map((c) => c.callIndex)).size).toBe(calls.length);
  });

  it("without snapshots the ledger is today's", () => {
    expect(foldFiles(stream, []).calls).toEqual(foldFiles(stream).calls);
    expect(foldFiles(stream).calls.some((c) => c.snapshot !== undefined)).toBe(false);
  });
});

describe("the operations view and the detail show the snapshot entry (item 3)", () => {
  const ops = (lang: "en" | "de") =>
    renderToStaticMarkup(
      <FilesOperations
        lang={lang}
        ledger={ledger}
        calls={ledger.calls}
        ordinals={ordinals}
        limit={stream.length}
        selection={{ call: null, path: null }}
        agents={false}
        onPick={() => {}}
      />,
    );

  it("names the entry with its files and lines, in both languages", () => {
    const en = ops("en");
    expect(en).toContain("Copilot file snapshot +15 −5");
    expect(en).toContain("parser.test.ts");
    expect(en).toContain(">Copilot file snapshot</td>");
    const de = ops("de");
    expect(de).toContain("Copilot-Dateischnappschuss +15 −5");
    expect(de).not.toContain(COPILOT_SNAPSHOT_TOOL);
  });

  it("the detail names the entry and each file's lines", () => {
    const html = renderToStaticMarkup(
      <FilesDetail
        lang="en"
        events={stream as RunEvent[]}
        ledger={ledger}
        rows={fileRows(ledger, null)}
        selection={{ call: shots[0].callIndex, path: null }}
        diffStyle="unified"
        limit={stream.length}
        onSelect={() => {}}
        onFocusEvent={() => {}}
        onOpenPath={null}
      />,
    );
    expect(html).toContain("Copilot file snapshot");
    expect(html).toContain("+12");
    expect(html).toContain("−4");
    expect(html).not.toContain(COPILOT_SNAPSHOT_TOOL);
  });
});

describe("the report shows the snapshots and their findings (item 3)", () => {
  it("lists each snapshot as its own entry", () => {
    const r = report();
    expect(
      r.snapshots.map((s) => ({
        callIndex: s.callIndex,
        added: s.added,
        removed: s.removed,
        files: s.files.map((f) => [f.label, f.what]),
      })),
    ).toEqual([
      {
        callIndex: shots[0].callIndex,
        added: 15,
        removed: 5,
        files: [
          ["src/parser.ts", "changed"],
          ["test/parser.test.ts", "created"],
          ["old/notes.txt", "deleted"],
        ],
      },
      {
        callIndex: shots[1].callIndex,
        added: 3,
        removed: 3,
        files: [
          [".env", "changed"],
          ["/srv/shared/settings.md", "changed"],
        ],
      },
    ]);
    expect(report(false).snapshots).toEqual([]);
  });

  it("a secret-shaped path gives the secret-file finding, a path outside the workspace the outside one", () => {
    const r = report();
    const secret = r.findings.find((f) => f.kind === "secret-file");
    expect(secret).toMatchObject({
      level: "critical",
      source: "recorded",
      tool: COPILOT_SNAPSHOT_TOOL,
      file: ".env",
    });
    expect(secret?.what).toEqual(["changed"]);
    const outside = r.findings.find((f) => f.kind === "outside");
    expect(outside).toMatchObject({
      level: "sensitive",
      source: "recorded",
      file: "/srv/shared/settings.md",
    });
    expect(r.verdict).toBe("critical");
    expect(report(false).findings.filter((f) => f.kind === "secret-file" || f.kind === "outside")).toEqual(
      [],
    );
  });

  it("the HTML report has the snapshot entries and says the stored contents were not read", () => {
    const en = reportHtml(report(), "en");
    expect(en).toContain('data-section="snapshots"');
    expect(en).toContain("Copilot file snapshot");
    expect(en).toContain("+15 −5");
    expect(en).toContain(
      "File snapshots of the Copilot folder were read for which files changed; their stored file contents were not read.",
    );
    expect(en).not.toContain(`<code>${COPILOT_SNAPSHOT_TOOL}</code>`);
    const de = reportHtml(report(), "de");
    expect(de).toContain("Copilot-Dateischnappschuss");
    expect(de).toContain(
      "Die Dateischnappschüsse des Copilot-Ordners wurden gelesen, um zu sehen, welche Dateien sich änderten; die gespeicherten Dateiinhalte wurden nicht gelesen.",
    );
  });

  it("a report without snapshots has neither the section nor the method line", () => {
    for (const lang of ["en", "de"] as const) {
      const html = reportHtml(report(false), lang);
      expect(html).not.toContain('data-section="snapshots"');
      expect(html).not.toContain("Copilot");
    }
  });

  it("the CSV has one row per snapshot", () => {
    const rows = reportCsv(report(), "en").split("\r\n");
    const snapRows = rows.filter((r) => r.includes("Copilot file snapshot"));
    expect(snapRows).toHaveLength(2);
    expect(snapRows[0]).toContain("changed created deleted");
    expect(snapRows[0]).toContain("+15 −5");
    expect(reportCsv(report(false), "en")).not.toContain("Copilot file snapshot");
    expect(reportCsv(report(), "de")).toContain("Copilot-Dateischnappschuss");
  });
});

describe("the snapshots never become a call of the stream", () => {
  it("no snapshot call is a tool_call event", () => {
    for (const c of shots as FileCall[]) {
      expect((stream[c.callIndex] as { type: string }).type).not.toBe("tool_call");
    }
  });
});

describe("the snapshots are neither saved nor exported (item 3)", () => {
  it("an imported Copilot folder opens read-only, so nothing saves it", () => {
    expect(replayComposer(`import:${loaded.kind}:${loaded.label}`, { liveElsewhere: [] })).toEqual({
      kind: "readOnly",
      reason: "import",
    });
  });

  it("no export of the stream carries a snapshot's file", () => {
    // parser.test.ts and old/notes.txt are named only by the snapshot index.
    expect(events).not.toContain("parser.test.ts");
    expect(index).toContain("parser.test.ts");
    for (const out of [
      toJsonl(stream),
      toVscodeAgentJsonl(stream),
      chatToHtml(stream),
      textFeedToHtml(stream),
    ]) {
      expect(out).not.toContain("parser.test.ts");
      expect(out).not.toContain("old/notes.txt");
      expect(out).not.toContain(COPILOT_SNAPSHOT_TOOL);
    }
  });
});

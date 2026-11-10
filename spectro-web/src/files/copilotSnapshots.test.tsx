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

// ---- fix round 1, item 1 (review I1) ------------------------------------------------

describe("a snapshot never stands on a tool event, listed or not (fix round 1 item 1)", () => {
  // The review's input: a web_fetch with a credential in its query whose turn
  // stopped before it completed, then the next prompt. The token is joined at
  // run time so no credential-shaped literal sits in this file.
  const token = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const rec = (r: object) => JSON.stringify(r);
  const at = (s: number) => `2026-11-10T09:00:0${s}.000Z`;
  const lines = [
    rec({
      type: "session.start",
      data: { sessionId: "s-stop", producer: "copilot-agent", context: { cwd: "/w" } },
      id: "a0",
      timestamp: at(0),
    }),
    rec({ type: "user.message", data: { content: "fetch it" }, id: "u1", timestamp: at(1) }),
    rec({
      type: "tool.execution_start",
      data: {
        toolCallId: "f1",
        toolName: "web_fetch",
        arguments: { url: `https://example.com/x?access_token=${token}` },
      },
      id: "a2",
      timestamp: at(2),
    }),
    rec({ type: "user.message", data: { content: "go on" }, id: "u2", timestamp: at(3) }),
  ].join("\n");
  const snapIndex = JSON.stringify({
    schema: 1,
    snapshots: [
      {
        eventId: "u1",
        files: {
          k: {
            path: "/w/src/a.ts",
            preimage: { kind: "content" },
            postimage: { kind: "content" },
            linesAdded: 1,
          },
        },
      },
    ],
  });
  const got = loadCopilotFolder({ events: lines, workspace: null, snapshots: snapIndex, live: false });
  const ledger2 = foldFiles(got.events, got.source.copilot?.snapshots ?? []);
  const shot = ledger2.calls.find((c) => c.snapshot !== undefined);

  it("steps past the stopped web_fetch call to a free event of its run", () => {
    expect(shot).toBeDefined();
    const type = (got.events[shot?.callIndex ?? -1] as { type: string }).type;
    expect(type).not.toBe("tool_call");
    expect(type).not.toBe("tool_result");
    // Still inside the run the first message opened.
    expect(got.source.copilot?.snapshots?.[0].from).toBeLessThanOrEqual(shot?.callIndex ?? -1);
  });

  it("the web_fetch finding names no file of the snapshot", () => {
    const r = buildReport({
      events: got.events,
      ledger: ledger2,
      sessionId: "import:vscode-agent:events.jsonl",
      title: null,
      version: null,
      now: 0,
    });
    const input = r.findings.find((f) => f.kind === "credential-input");
    expect(input?.tool).toBe("web_fetch");
    expect(input?.file).toBeNull();
  });

  it("a finding takes no file from another call at its index", () => {
    // A ledger where a snapshot sat on the web_fetch's index, as before the fix.
    const fetchAt = got.events.findIndex((e) => e.type === "tool_call");
    const moved = {
      ...ledger2,
      calls: ledger2.calls.map((c) =>
        c.snapshot === undefined
          ? c
          : { ...c, callIndex: fetchAt, touches: c.touches.map((t) => ({ ...t, callIndex: fetchAt })) },
      ),
    };
    const r = buildReport({
      events: got.events,
      ledger: moved,
      sessionId: "import:vscode-agent:events.jsonl",
      title: null,
      version: null,
      now: 0,
    });
    expect(r.findings.find((f) => f.kind === "credential-input")?.file).toBeNull();
  });

  it("steps past a completed unlisted call's result too", () => {
    const done = JSON.stringify({
      type: "tool.execution_complete",
      data: { toolCallId: "f1", success: true, result: { content: "ok" } },
      id: "a3",
      timestamp: "2026-11-10T09:00:02.500Z",
    });
    const withResult = lines.replace(
      '\n{"type":"user.message","data":{"content":"go on"}',
      `\n${done}\n{"type":"user.message","data":{"content":"go on"}`,
    );
    expect(withResult).not.toBe(lines);
    const loaded2 = loadCopilotFolder({
      events: withResult,
      workspace: null,
      snapshots: snapIndex,
      live: false,
    });
    const call = foldFiles(loaded2.events, loaded2.source.copilot?.snapshots ?? []).calls.find(
      (c) => c.snapshot !== undefined,
    );
    const type = (loaded2.events[call?.callIndex ?? -1] as { type: string }).type;
    expect(["tool_call", "tool_result"]).not.toContain(type);
  });
});

describe("the report names snapshot files of an unknown kind (fix round 1 item 9)", () => {
  const odd = index.replace(
    '"kind": "absent" },\n          "postimage": { "kind": "content", "contentHash": "h3"',
    '"kind": "lorem" },\n          "postimage": { "kind": "content", "contentHash": "h3"',
  );
  const r = () => {
    const got = loadCopilotFolder({ events, workspace, snapshots: odd, live: false });
    return buildReport({
      events: got.events,
      ledger: foldFiles(got.events, got.source.copilot?.snapshots ?? []),
      sessionId: "s",
      title: null,
      version: null,
      now: 0,
    });
  };

  it("counts it as changed, not created, and says so in the method", () => {
    expect(odd).not.toBe(index);
    const files = r().snapshots[0].files;
    expect(files.map((f) => [f.label, f.what, f.unknownKind])).toEqual([
      ["src/parser.ts", "changed", false],
      ["test/parser.test.ts", "changed", true],
      ["old/notes.txt", "deleted", false],
    ]);
    expect(reportHtml(r(), "en")).toContain(
      "1 file of the Copilot snapshots names a kind this report does not know, so it counts as changed.",
    );
    expect(reportHtml(r(), "de")).toContain(
      "1 Datei der Copilot-Schnappschüsse nennt eine Art, die dieser Bericht nicht kennt; sie zählt deshalb als geändert.",
    );
  });

  it("names the count in the plural, and says nothing when every kind is known", () => {
    expect(reportHtml(report(), "en")).not.toContain("names a kind this report does not know");
    expect(reportHtml(report(), "en")).not.toContain("name a kind this report does not know");
    const both = odd.replace('"kind": "absent" }', '"kind": "lorem" }');
    const got = loadCopilotFolder({ events, workspace, snapshots: both, live: false });
    const html = reportHtml(
      buildReport({
        events: got.events,
        ledger: foldFiles(got.events, got.source.copilot?.snapshots ?? []),
        sessionId: "s",
        title: null,
        version: null,
        now: 0,
      }),
      "en",
    );
    expect(html).toContain(
      "2 files of the Copilot snapshots name a kind this report does not know, so they count as changed.",
    );
  });
});

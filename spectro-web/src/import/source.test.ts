// The imported source line, carried through to the renderer.
//
// The whole point of carrying it is that a reader can hold the pane next to
// the file and see the same bytes. So the load-bearing test here reads a REAL
// transcript's lines off the disk with no bundler in the path, and compares
// with ===. Anything softer (a parse, a normalisation, a shape assertion)
// would pass while the claim on the screen was false.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourcePane } from "../components/traceDetail";
import { attachSources } from "../state/traceSource";
import type { RunEvent } from "../events";
import { detectAndLoad } from "./detect";

const path = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const fixture = (name: string): string => readFileSync(path(name), "utf8");

/** The file's lines as raw byte slices, cut on 0x0A and nothing else. No trim,
 *  no filter, no decode: this is the side of the comparison that has to owe the
 *  implementation nothing. */
const rawLines = (name: string): Buffer[] => {
  const parts: Buffer[] = [];
  const bytes = readFileSync(path(name));
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      parts.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  parts.push(bytes.subarray(start));
  return parts;
};

/** The lines the importer is supposed to have carried: the file's own, in
 *  place, nothing touched. Blank ones included, because a line the reader
 *  scrolls past is still a line, and a file that ends with a newline has one
 *  empty piece after its last record which is not one. */
const fileLines = (text: string): string[] => {
  const parts = text.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

describe("the carried source", () => {
  it("carries every source line byte-identical to the input", () => {
    // Harvested from real transcripts: a signature, a base64 image block, a
    // doubly escaped hook stdout, ANSI control escapes, emoji, a Bash command
    // whose content is a literal backslash-n, and a record that produces no
    // event at all.
    const text = fixture("cc-heavy.jsonl");
    const expected = fileLines(text);

    const { source } = detectAndLoad(text);

    expect(source.lines.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(source.lines[i]).toBe(expected[i]);
    }
    // Named on their own so a failure says WHICH shape broke, not just "line 4".
    expect(source.lines[1]).toContain('"signature"');
    expect(source.lines[3]).toContain("\\n"); // the heredoc's literal backslash-n
    expect(source.lines[4]).toContain("\\u001b"); // ANSI, still escaped
  });

  it("carries the lines of every fixture byte-identical, whatever the format", () => {
    for (const name of ["cc-linear.jsonl", "cc-modern.jsonl", "cc-workflow.jsonl", "vscode-agent.jsonl"]) {
      const text = fixture(name);
      const { source } = detectAndLoad(text);
      expect(source.lines).toEqual(fileLines(text));
    }
  });

  it("carries a line's surrounding whitespace, measured against the file's bytes", () => {
    // The two tests above derive what they expect with the SAME expression the
    // importer uses, so a change to that expression moves both sides at once.
    // This one owes it nothing: it names the byte slices by position and
    // compares bytes with bytes. The fixture is built for it, because no real
    // transcript indents its records and the claim on screen is nevertheless
    // "byte for byte".
    const parts = rawLines("cc-indented.jsonl");
    // 0 a plain record, 1 indented by two spaces, 2 empty, 3 spaces only,
    // 4 closed by a tab and a space, 5 the tail after the final newline.
    expect(parts).toHaveLength(6);

    const { source } = detectAndLoad(fixture("cc-indented.jsonl"));

    // Five lines and not three: the two blank ones are held in place. Dropping
    // them would carry the same bytes under different numbers, and the number
    // is half of what the pane says.
    expect(source.lines).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(Buffer.from(source.lines[i], "utf8").equals(parts[i])).toBe(true);
    }
    // Said out loud as well, so a failure reads as the defect rather than as a
    // buffer mismatch: the whitespace is part of the line, not noise around it.
    expect(source.lines[1].startsWith("  ")).toBe(true);
    expect(source.lines[4].endsWith("\t ")).toBe(true);
  });

  it("carries a spectroscope session's own lines too", () => {
    // Our own file is byte-identical to a re-stringify only because WE wrote
    // it. Carrying the line makes that checkable instead of asserted.
    const text = [
      JSON.stringify({ type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 }),
      JSON.stringify({ type: "text_delta", agentId: "main", text: "hello", ts: 2 }),
      JSON.stringify({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 }),
    ].join("\n");
    const { source } = detectAndLoad(text);
    expect(source.lines).toEqual(fileLines(text));
  });
});

describe("the origin of each frame", () => {
  it("gives every event exactly one origin, or -1", () => {
    const { events, source } = detectAndLoad(fixture("cc-workflow.jsonl"));
    expect(source.origin.length).toBe(events.length);
    for (let i = 0; i < events.length; i++) {
      const o = source.origin[i];
      expect(o).toBeGreaterThanOrEqual(-1);
      expect(o).toBeLessThan(source.lines.length);
    }
  });

  it("marks the frames the importer built itself, not the file", () => {
    // provider_info is announced before the record loop; run_end and the
    // unsettled receipts are pushed after it. No single line produced them.
    const { events, source } = detectAndLoad(fixture("cc-workflow.jsonl"));
    const originOf = (type: string): number => source.origin[events.findIndex((e) => e.type === type)];
    expect(originOf("provider_info")).toBe(-1);
    expect(source.origin[events.length - 1]).toBe(-1); // the closing run_end
    expect(events[events.length - 1].type).toBe("run_end");
  });

  it("does not desynchronise on a record that emits nothing", () => {
    // cc-modern carries a last-prompt record, and cc-heavy an orphaned
    // sidechain that returns early. Both leave `out` untouched for a record,
    // which is exactly where a captured start index would drift. (cc-modern's
    // leading queue-operations used to be the example here; card 141 turned
    // them into frames, and the last-prompt took over the job.)
    for (const name of ["cc-modern.jsonl", "cc-heavy.jsonl"]) {
      const { events, source } = detectAndLoad(fixture(name));
      expect(source.origin.length).toBe(events.length);
      // Every origin that names a line names one that really exists, and the
      // origins never run backwards: a frame cannot come from an earlier line
      // than the frame before it.
      let last = -1;
      for (const o of source.origin) {
        if (o < 0) continue;
        expect(o).toBeGreaterThanOrEqual(last);
        last = o;
      }
    }
  });

  it("maps a spectroscope import one line to one event", () => {
    const text = [
      JSON.stringify({ type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 }),
      JSON.stringify({ type: "text_delta", agentId: "main", text: "hello", ts: 2 }),
      JSON.stringify({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 }),
    ].join("\n");
    const { events, source } = detectAndLoad(text);
    expect(source.origin.length).toBe(events.length);
    expect([...source.origin]).toEqual([0, 1, 2]);
  });

  it("gives a VS Code export an origin per frame too", () => {
    const { events, source } = detectAndLoad(fixture("vscode-agent.jsonl"));
    expect(source.origin.length).toBe(events.length);
    expect(source.origin[events.length - 1]).toBe(-1); // its run_end is built too
  });
});

// The pane says "Line n of total" and its own doc calls n "the number a reader
// counts to when opening the file". A blank line carries no frame, but it still
// costs the reader a line when they scroll to it, so an index that skipped it
// would name a line the file does not have there.
describe("the number the pane puts on screen", () => {
  const paneRows = (events: readonly RunEvent[], origin: ArrayLike<number>) =>
    attachSources(
      events.map((e) => ({ payload: e as unknown, type: (e as { type: string }).type, dir: "in" as const })),
      events,
      origin,
    );

  it("counts the blank lines the file has", () => {
    const text = [
      JSON.stringify({ type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 }),
      "",
      JSON.stringify({ type: "text_delta", agentId: "main", text: "hello", ts: 2 }),
      "   ",
      JSON.stringify({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 }),
    ].join("\n");

    const { events, source } = detectAndLoad(text);
    const rows = paneRows(events, source.origin);
    const pane = sourcePane(rows[2], rows, source.lines, "stored");

    // The run_end record sits on line 5 of a file that has 5 lines.
    expect(pane).toMatchObject({ kind: "line", lineNumber: 5, total: 5 });
    expect(pane.kind === "line" ? pane.text : "").toBe(text.split("\n")[4]);
  });

  it("holds a real transcript's numbers against the file's own bytes", () => {
    // The indented fixture is the one file here with blank lines in the middle,
    // which is why it was built: parts 2 and 3 are blank, so the third carried
    // record is physical line 5.
    const text = fixture("cc-indented.jsonl");
    const parts = rawLines("cc-indented.jsonl");
    const { events, source } = detectAndLoad(text);
    const rows = paneRows(events, source.origin);

    const last = rows.filter((r) => r.sourceLine !== undefined).at(-1)!;
    const pane = sourcePane(last, rows, source.lines, "stored");

    expect(pane).toMatchObject({ kind: "line", lineNumber: 5, total: 5 });
    expect(Buffer.from(pane.kind === "line" ? pane.text : "", "utf8").equals(parts[4])).toBe(true);
  });
});

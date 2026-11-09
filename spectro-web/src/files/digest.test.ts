// Card 604: the digest a model reads. It is the exact text the consent sheet
// shows and the browser sends, so these cases pin what is in it and what never
// is: one line per file call, shell outputs cut to a bound, and nothing a file
// tool wrote.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildFilesDigest, FILES_DIGEST_MAX, OUTPUT_MAX } from "./digest";
import { foldFiles } from "./fold";

const T0 = 1_760_000_000_000;

/** A session of tool calls, each with its result, one second apart. */
function session(calls: { name: string; input: unknown; output?: string }[], workspace = "/ws"): RunEvent[] {
  const events: object[] = [{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace }];
  calls.forEach((c, i) => {
    events.push({ type: "tool_call", agentId: "main", callId: `c${i}`, name: c.name, input: c.input });
    events.push({
      type: "tool_result",
      agentId: "main",
      callId: `c${i}`,
      output: c.output ?? "ok",
      isError: false,
      durationMs: 5,
    });
  });
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

describe("the files digest", () => {
  it("oneLinePerCallWithItsIndex", () => {
    const ledger = foldFiles(
      session([
        { name: "read_file", input: { path: "README.md" } },
        { name: "run_command", input: { command: "ls src" }, output: "a.ts\nb.ts" },
        { name: "web_fetch", input: { url: "https://example.com" } },
      ]),
    );
    const digest = buildFilesDigest(ledger);
    const lines = digest.text.split("\n");
    expect(lines[0]).toBe("workspace: /ws");
    expect(lines.slice(1)).toEqual([
      "#1 1.0s main read_file: README.md",
      "#3 3.0s main run_command: ls src",
      "  output: a.ts ⏎ b.ts",
    ]);
    expect(digest.calls).toBe(2);
    expect(digest.truncated).toBe(false);
    // Without a workspace the header says so.
    const bare = buildFilesDigest(foldFiles(session([{ name: "read_file", input: { path: "a" } }], "")));
    expect(bare.text.split("\n")[0]).toBe("workspace: unknown");
  });

  it("writtenContentNeverLeaves", () => {
    const ledger = foldFiles(
      session([
        { name: "write_file", input: { path: "notes.txt", content: "SECRET-CONTENT" } },
        { name: "edit_file", input: { path: "a.ts", old_string: "OLD-SECRET", new_string: "NEW-SECRET" } },
      ]),
    );
    // The fold holds the text, so its absence below is the digest's doing.
    expect(ledger.calls[0].touches[0].content).toBe("SECRET-CONTENT");
    expect(ledger.calls[1].touches[0].replaced).toEqual([{ old: "OLD-SECRET", new: "NEW-SECRET" }]);
    const { text } = buildFilesDigest(ledger);
    expect(text).not.toContain("SECRET-CONTENT");
    expect(text).not.toContain("OLD-SECRET");
    expect(text).not.toContain("NEW-SECRET");
    // The positive twin: both calls are there, by path.
    expect(text).toContain("#1 1.0s main write_file: notes.txt");
    expect(text).toContain("#3 3.0s main edit_file: a.ts");
  });

  it("outputsAreCutTo2000", () => {
    expect(OUTPUT_MAX).toBe(2_000);
    const ledger = foldFiles(
      session([{ name: "run_command", input: { command: "cat big.log" }, output: "x".repeat(5_000) }]),
    );
    const { text } = buildFilesDigest(ledger);
    const output = text.split("\n").find((line) => line.startsWith("  output: "));
    expect(output).toBeDefined();
    const body = output!.slice("  output: ".length);
    expect(body.startsWith("x".repeat(OUTPUT_MAX))).toBe(true);
    expect(body.split("x").length - 1).toBe(OUTPUT_MAX);
    expect(body.endsWith(" [cut]")).toBe(true);
    // A short output is left whole.
    const short = buildFilesDigest(
      foldFiles(session([{ name: "run_command", input: { command: "ls" }, output: "a" }])),
    );
    expect(short.text).toContain("  output: a");
    expect(short.text).not.toContain("[cut]");
  });

  it("theOldestOutputsGoFirst", () => {
    expect(FILES_DIGEST_MAX).toBe(60_000);
    // Forty commands with 2,000 characters of output each: 80,000 in outputs alone.
    const calls = Array.from({ length: 40 }, (_, i) => ({
      name: "run_command",
      input: { command: `make step${i}` },
      output: `out${i}:`.padEnd(OUTPUT_MAX, "y"),
    }));
    const ledger = foldFiles(session(calls));
    const digest = buildFilesDigest(ledger);
    expect(digest.text.length).toBeLessThanOrEqual(FILES_DIGEST_MAX);
    expect(digest.truncated).toBe(true);
    expect(digest.calls).toBe(40);
    const lines = digest.text.split("\n");
    // The newest output is intact, the oldest is replaced.
    expect(lines).toContain(`  output: ${calls[39].output}`);
    const first = lines.indexOf("#1 1.0s main run_command: make step0");
    expect(first).toBeGreaterThan(0);
    expect(lines[first + 1]).toBe("  output: [cut]");
    // Cut in order: no kept output stands before a cut one.
    const outputs = lines.filter((line) => line.startsWith("  output: "));
    const lastCut = outputs.lastIndexOf("  output: [cut]");
    expect(outputs.slice(0, lastCut + 1).every((line) => line === "  output: [cut]")).toBe(true);
    expect(outputs.slice(lastCut + 1).every((line) => line !== "  output: [cut]")).toBe(true);
  });

  it("theOldestLinesGoWhenCuttingOutputsIsNotEnough", () => {
    const calls = Array.from({ length: 1_200 }, (_, i) => ({
      name: "read_file",
      input: { path: `src/module-${i}/a-long-file-name-for-the-bound.ts` },
    }));
    const digest = buildFilesDigest(foldFiles(session(calls)));
    expect(digest.text.length).toBeLessThanOrEqual(FILES_DIGEST_MAX);
    expect(digest.truncated).toBe(true);
    expect(digest.calls).toBeLessThan(1_200);
    const lines = digest.text.split("\n");
    expect(lines[0]).toBe(`workspace: /ws (the oldest ${1_200 - digest.calls} calls are left out)`);
    expect(lines.length - 1).toBe(digest.calls);
    // The newest call is the last line.
    expect(lines[lines.length - 1]).toContain("src/module-1199/");
  });
});

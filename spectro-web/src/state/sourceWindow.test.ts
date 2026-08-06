import { describe, expect, it } from "vitest";
import { cutAroundBlob, sourceWindow } from "./sourceWindow";

const blob = "A".repeat(31842);
const record = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${blob}"}}]},"uuid":"u1"}`;

const textOf = (t: { segments: { kind: string; text?: string }[] } | null): string =>
  (t?.segments ?? [])
    .filter((x) => x.kind === "text")
    .map((x) => x.text ?? "")
    .join("");
const blobsOf = (t: { segments: { kind: string; chars?: number }[] } | null): number[] =>
  (t?.segments ?? []).filter((x) => x.kind === "blob").map((x) => x.chars ?? 0);

describe("cutting a line around its blobs", () => {
  it("measures a blob rather than printing it", () => {
    const cut = cutAroundBlob(record, 412);
    expect(blobsOf(cut)).toEqual([31842]);
    expect(textOf(cut)).not.toContain(blob);
  });

  it("keeps the fields that NAME the blob, which sit just in front of it", () => {
    const text = textOf(cutAroundBlob(record, 412));
    expect(text).toContain('"media_type":"image/png"');
    expect(text).toContain('"type":"base64"');
  });

  it("keeps what follows, so the record's shape is visible", () => {
    expect(textOf(cutAroundBlob(record, 1))).toContain('"uuid":"u1"');
  });

  // Found by looking at the running app: the owner's opening record holds FOUR
  // screenshots, and a version that marked only the first printed the next
  // one's raw base64 in the tail.
  it("marks EVERY blob, not only the first", () => {
    const four = `{"content":[${[31842, 40000, 12000, 9000]
      .map((n) => `{"type":"image","source":{"type":"base64","data":"${"A".repeat(n)}"}}`)
      .join(",")}]}`;
    const cut = cutAroundBlob(four, 5);
    expect(blobsOf(cut)).toEqual([31842, 40000, 12000, 9000]);
    expect(cut?.blobs).toBe(4);
    expect(textOf(cut)).not.toMatch(/A{200,}/);
  });

  it("keeps the seam between two blobs, which shows they are siblings", () => {
    const two = `{"c":[{"data":"${"A".repeat(500)}"},{"data":"${"B".repeat(500)}"}]}`;
    expect(textOf(cutAroundBlob(two, 1))).toContain('"},{"data":"');
  });

  it("says nothing about a line that carries no blob", () => {
    expect(cutAroundBlob('{"type":"user","message":{"content":"just words"}}', 1)).toBeNull();
  });

  // A short run of base64-ish characters is any ordinary word. The threshold is
  // what keeps `"type":"assistant"` from being read as a picture.
  it("is not fooled by ordinary text", () => {
    expect(cutAroundBlob('{"model":"claude-opus-5","stop_reason":"tool_use"}', 1)).toBeNull();
  });
});

describe("the window around a line", () => {
  const lines = ['{"n":1}', '{"n":2}', record, '{"n":4}', '{"n":5}', '{"n":6}', '{"n":7}', '{"n":8}'];

  it("shows the file before and after, numbered the way an editor numbers it", () => {
    const w = sourceWindow(lines, 2, 2);
    expect(w.above.map((l) => l.number)).toEqual([1, 2]);
    expect(w.target?.number).toBe(3);
    expect(w.below.map((l) => l.number)).toEqual([4, 5]);
    expect(w.total).toBe(8);
  });

  it("does not walk off the start of the file", () => {
    const w = sourceWindow(lines, 0, 3);
    expect(w.above).toEqual([]);
    expect(w.below.map((l) => l.number)).toEqual([2, 3, 4]);
  });

  it("does not walk off the end", () => {
    const w = sourceWindow(lines, 7, 3);
    expect(w.below).toEqual([]);
    expect(w.above.map((l) => l.number)).toEqual([5, 6, 7]);
  });

  it("answers a line that is not in the file rather than throwing", () => {
    expect(sourceWindow(lines, 99).target).toBeNull();
    expect(sourceWindow(lines, -1).total).toBe(8);
  });

  // A neighbour is often another 40 KB record. The window is for orientation.
  it("clips a neighbour, so one long record does not become the whole pane", () => {
    const long = ["x".repeat(5000), record, "y"];
    const w = sourceWindow(long, 1, 1);
    expect(w.above[0].text.length).toBeLessThan(300);
    expect(w.above[0].text.endsWith("…")).toBe(true);
  });

  it("never prints the blob, at any window size", () => {
    const w = sourceWindow(lines, 2, 3);
    const printed = [...w.above, ...w.below].map((l) => l.text).join("") + textOf(w.target);
    expect(printed).not.toContain(blob);
  });
});

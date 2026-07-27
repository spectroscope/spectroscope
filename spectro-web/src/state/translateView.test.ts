// The mounted half of the translation, tested where it is pure.
//
// Two things carry the wiring. First the SIZE problem, measured on a real
// imported transcript: 157 units, ~150 000 characters, longest single unit
// 33 628 — against a server that takes 4 000 characters per passage, 60 000
// per request and 40 passages at a time. So the round trip plan -> batches ->
// wire -> apply is the thing that has to hold, and this file drives a unit far
// past the server's per-passage bound through all of it.
//
// Second the trace: a live session's wire view carries the frames THIS app
// sent, which are not events and have no translation. Swapping payloads by
// identity keeps them where they are instead of dropping them on the floor.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { applyUnits, extractUnits } from "../translate/units";
import {
  EMPTY_FOLD,
  MAX_CHARS_PER_REQUEST,
  MAX_PASSAGES_PER_REQUEST,
  batchPassages,
  foldMessage,
  passageKey,
  planFor,
  settledUnits,
  swapTracePayloads,
} from "./translate";
import type { RunFold } from "./translate";

// TranslateController's own bounds, restated: the wire the client has to fit.
const SERVER_MAX_UNIT_CHARS = 4_000;
const SERVER_MAX_TEXT_CHARS = 60_000;
const SERVER_MAX_UNITS = 40;

const CODE = ["```bash", "grep -R 'ERROR' /var/log/app.log | tail -50", "```"].join("\n");

/** Prose in the language the reader cannot read, long enough to matter. */
function incidentReport(minChars: number): string {
  const paragraphs: string[] = [CODE];
  let size = CODE.length;
  for (let i = 0; size < minChars; i++) {
    const paragraph =
      `Абзац ${i}: о ${i}:15 сервіс відповів помилкою, і черга почала рости. ` +
      "Ми перезапустили воркер, перевірили журнал і зафіксували час відновлення.";
    paragraphs.push(paragraph);
    size += paragraph.length + 2;
  }
  return paragraphs.join("\n\n");
}

/** The answer as it really arrives: many fragments of one sentence. */
function deltas(text: string, count: number): RunEvent[] {
  const size = Math.ceil(text.length / count);
  const out: RunEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ type: "text_delta", agentId: "main", text: text.slice(i, i + size), ts: 100 + i });
  }
  return out;
}

/** The fake provider: a marker no source text carries, so the round trip is
 *  checkable by removing it again rather than by re-running the join. */
const wrap = (text: string): string => `⟦${text}⟧`;
const MARKERS = /[⟦⟧]/g;

describe("the size problem — a unit far past the server's per-passage bound", () => {
  // The measured shape of a real imported transcript: ~150 000 characters of
  // prose, the longest single answer 33 628.
  const answers = [incidentReport(33_628), incidentReport(30_000), incidentReport(30_000)];
  const events: RunEvent[] = answers.flatMap((answer, run) => [
    { type: "run_start", runId: `r${run}`, agentId: "main", prompt: `що сталося ${run}?`, ts: run * 10_000 },
    ...deltas(answer, 340),
    { type: "run_end", runId: `r${run}`, stopReason: "end_turn", ts: run * 10_000 + 9_000 },
  ]);

  it("extracts an answer unit that no single request could carry", () => {
    const units = extractUnits(events);
    const longest = Math.max(...units.map((u) => u.text.length));
    expect(longest).toBeGreaterThan(SERVER_MAX_UNIT_CHARS);
    expect(units.filter((u) => u.kind === "answer")).toHaveLength(answers.length);
    expect(units.reduce((n, u) => n + u.text.length, 0)).toBeGreaterThan(SERVER_MAX_TEXT_CHARS);
  });

  it("cuts it into passages the server accepts, code left behind", () => {
    const plan = planFor(events);
    for (const passage of plan.passages) {
      expect(passage.text.length).toBeLessThanOrEqual(SERVER_MAX_UNIT_CHARS);
      expect(passage.text).not.toContain("```");
    }
    expect(plan.passages.length).toBeGreaterThan(SERVER_MAX_UNITS);
  });

  it("packs those passages into requests the server accepts", () => {
    const batches = batchPassages(planFor(events).passages, {
      maxPassages: MAX_PASSAGES_PER_REQUEST,
      maxChars: MAX_CHARS_PER_REQUEST,
    });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(SERVER_MAX_UNITS);
      expect(batch.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(SERVER_MAX_TEXT_CHARS);
    }
  });

  it("puts the answers back together into the stream, character for character", () => {
    const plan = planFor(events);
    const batches = batchPassages(plan.passages, {
      maxPassages: MAX_PASSAGES_PER_REQUEST,
      maxChars: MAX_CHARS_PER_REQUEST,
    });

    // The server, faithfully: one NDJSON run per request, indices per request.
    let fold: RunFold = EMPTY_FOLD;
    for (const batch of batches) {
      const keys = batch.map((passage) => passageKey(passage.unitId, passage.pieceIndex));
      fold = foldMessage(
        fold,
        {
          meta: {
            engine: "local",
            provider: "spectro-local",
            model: "m",
            target: "German",
            units: batch.length,
          },
        },
        keys,
      );
      batch.forEach((passage, index) => {
        fold = foldMessage(fold, { unit: index, delta: wrap(passage.text) }, keys);
        fold = foldMessage(fold, { unit: index, end: true }, keys);
      });
    }

    const landed = settledUnits(plan, fold);
    expect(landed.size).toBe(plan.units.filter((u) => u.pieces.some((p) => p.kind === "text")).length);

    const applied = applyUnits(events, landed);
    const joined = applied
      .filter((e): e is Extract<RunEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");

    // Every prose passage came back wrapped, the code block never left, and
    // taking the wrappers off again yields the recorded answer exactly.
    const answerIds = new Set(plan.units.filter((u) => u.kind === "answer").map((u) => u.id));
    expect(joined).toContain(CODE);
    expect(joined.replace(MARKERS, "")).toBe(answers.join(""));
    expect((joined.match(/⟦/g) ?? []).length).toBe(
      plan.passages.filter((p) => answerIds.has(p.unitId)).length,
    );
    // The record itself is untouched: the recorded stream still reads as it did.
    expect(
      events
        .filter((e): e is Extract<RunEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.text)
        .join(""),
    ).toBe(answers.join(""));
  });
});

describe("swapTracePayloads — a translated wire view that still shows what we sent", () => {
  const original: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "привіт", ts: 1 },
    { type: "text_delta", agentId: "main", text: "Синє світло", ts: 2 },
  ];
  const translated = applyUnits(original, new Map([["1:text", "Blue light"]]));
  const rows = [
    { seq: 1, dir: "out" as const, ts: 0, type: "user_message", payload: { type: "user_message" } },
    { seq: 2, dir: "in" as const, ts: 1, type: "run_start", payload: original[0] },
    { seq: 3, dir: "in" as const, ts: 2, type: "text_delta", payload: original[1] },
  ];

  it("puts the translated event under the row that carried the original", () => {
    const swapped = swapTracePayloads(rows, original, translated);
    expect(swapped[2].payload).toBe(translated[1]);
    expect((swapped[2].payload as { text: string }).text).toBe("Blue light");
    expect(swapped[2].seq).toBe(3);
  });

  it("leaves a frame this app sent exactly where it is — it is not an event", () => {
    const swapped = swapTracePayloads(rows, original, translated);
    expect(swapped[0]).toBe(rows[0]);
    expect(swapped).toHaveLength(3);
  });

  it("keeps every row's identity when the translation changed nothing", () => {
    const swapped = swapTracePayloads(rows, original, original);
    expect(swapped[1]).toBe(rows[1]);
    expect(swapped[2]).toBe(rows[2]);
  });
});

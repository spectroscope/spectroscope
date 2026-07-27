import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import {
  EMPTY_FOLD,
  MAX_PASSAGE_CHARS,
  batchPassages,
  defaultTarget,
  emptyTranslation,
  failedUnits,
  foldMessage,
  joinUnit,
  parseTranslateChunk,
  passageKey,
  planTranslation,
  requestBody,
  setEngine,
  setShow,
  setTarget,
  settledUnits,
  splitUnit,
  toggleShow,
  translatedEvents,
  translationOf,
} from "./translate";
import type { Passage, TranslateMessage, TranslationUnit } from "./translate";

const unit = (id: string, text: string, kind: TranslationUnit["kind"] = "answer"): TranslationUnit => ({
  id,
  kind,
  text,
});

describe("splitUnit — what leaves the browser and what never does", () => {
  it("keeps plain prose as one piece", () => {
    const pieces = splitUnit("Синє світло розсіюється.", MAX_PASSAGE_CHARS);
    expect(pieces).toEqual([{ kind: "text", text: "Синє світло розсіюється.", before: "", after: "" }]);
  });

  it("cuts a fenced block out of the prose", () => {
    const text = ["Run this first:", "", "```bash", "rm -rf ./build", "```", "", "Then read the log."].join(
      "\n",
    );
    const pieces = splitUnit(text, MAX_PASSAGE_CHARS);
    expect(pieces.map((p) => p.kind)).toEqual(["text", "code", "text"]);
    expect(pieces[1].text).toBe("```bash\nrm -rf ./build\n```");
  });

  it("treats an unterminated fence as code — half a code block is still not prose", () => {
    const pieces = splitUnit("Here:\n\n```\nSELECT * FROM incidents", MAX_PASSAGE_CHARS);
    expect(pieces[pieces.length - 1].kind).toBe("code");
  });

  it("splits long prose at line ends, under the cap", () => {
    const para = "Ein Absatz mit genug Text, um die Grenze zu reissen.";
    const long = Array.from({ length: 200 }, () => para).join("\n\n");
    const pieces = splitUnit(long, MAX_PASSAGE_CHARS);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
  });

  it("hard-splits a single line over the cap rather than exceeding it", () => {
    const monster = "x".repeat(MAX_PASSAGE_CHARS * 2 + 5);
    const pieces = splitUnit(monster, MAX_PASSAGE_CHARS);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
  });
});

describe("joinUnit — the record survives the round trip", () => {
  const samples = [
    "plain prose",
    "Read this:\n\n```\nls -la\n```\n\nDone.",
    "trailing newline\n",
    "\n\nleading blank lines",
    "```\nonly code\n```",
    "x".repeat(MAX_PASSAGE_CHARS * 2 + 5),
    Array.from({ length: 120 }, (_, i) => `line ${i} with a bit of text to push past the cap`).join("\n"),
    "",
  ];

  it("reproduces the original byte for byte when nothing is translated", () => {
    for (const text of samples) {
      expect(joinUnit(splitUnit(text, MAX_PASSAGE_CHARS), new Map())).toBe(text);
    }
  });

  it("rejoins a hard-split line without inventing a line break", () => {
    const monster = "x".repeat(MAX_PASSAGE_CHARS + 10);
    const pieces = splitUnit(monster, MAX_PASSAGE_CHARS);
    expect(pieces.length).toBeGreaterThan(1);
    expect(joinUnit(pieces, new Map())).toBe(monster);
  });

  it("puts the translation in place of the prose and leaves the code verbatim", () => {
    const pieces = splitUnit("Lies:\n\n```\nls -la\n```\n\nFertig.", MAX_PASSAGE_CHARS);
    const joined = joinUnit(
      pieces,
      new Map([
        [0, "Read:"],
        [2, "Done."],
      ]),
    );
    expect(joined).toBe("Read:\n\n```\nls -la\n```\n\nDone.");
  });
});

describe("planTranslation — the calls one run will make", () => {
  it("makes one passage per prose piece, keyed by unit and piece", () => {
    const plan = planTranslation([unit("u1", "hallo"), unit("u2", "welt")]);
    expect(plan.passages.map((p) => passageKey(p.unitId, p.pieceIndex))).toEqual(["u1#0", "u2#0"]);
  });

  it("carries the unit kind onto the passage — the prompt needs to say what this text is", () => {
    const plan = planTranslation([unit("u1", "übersetze mir das", "prompt")]);
    expect(plan.passages[0].kind).toBe("prompt");
  });

  it("never sends a code piece", () => {
    const plan = planTranslation([unit("u1", "Do:\n\n```\nrm -rf /\n```")]);
    expect(plan.passages).toHaveLength(1);
    expect(plan.passages.map((p) => p.text).join("")).not.toContain("rm -rf");
  });

  it("plans nothing for a unit that is only code — it stays as it was recorded", () => {
    const plan = planTranslation([unit("u1", "```\nls -la\n```")]);
    expect(plan.passages).toEqual([]);
    expect(plan.units).toHaveLength(1);
  });

  it("skips a whitespace-only piece — there is nothing to translate", () => {
    const plan = planTranslation([unit("u1", "\n\n```\ncode\n```\n\n")]);
    for (const passage of plan.passages) expect(passage.text.trim()).not.toBe("");
  });

  it("hands the model the passage and not the blank lines around it", () => {
    const plan = planTranslation([unit("u1", "Lies:\n\n```\nls\n```\n\nFertig.")]);
    expect(plan.passages.map((p) => p.text)).toEqual(["Lies:", "Fertig."]);
  });

  it("keeps every unit's pieces so the answer can be put back together", () => {
    const plan = planTranslation([unit("u1", "a\n\n```\nb\n```")]);
    expect(plan.units[0].pieces.map((p) => p.kind)).toEqual(["text", "code"]);
  });
});

describe("batchPassages — the server's bounds, honoured without dropping anything", () => {
  const passages = (n: number, chars = 10): Passage[] =>
    Array.from({ length: n }, (_, i) => ({
      unitId: `u${i}`,
      pieceIndex: 0,
      kind: "answer",
      text: "y".repeat(chars),
    }));

  it("sends one request when everything fits", () => {
    expect(batchPassages(passages(3), { maxPassages: 40, maxChars: 1000 })).toHaveLength(1);
  });

  it("cuts a new request at the passage count", () => {
    const batches = batchPassages(passages(5), { maxPassages: 2, maxChars: 10000 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("cuts a new request at the character budget", () => {
    const batches = batchPassages(passages(5, 40), { maxPassages: 40, maxChars: 100 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("carries every passage — a long session is batched, never truncated", () => {
    const all = passages(97, 700);
    const batches = batchPassages(all, { maxPassages: 40, maxChars: 60000 });
    expect(batches.flat()).toEqual(all);
  });

  it("still emits an over-long passage alone rather than losing it", () => {
    const batches = batchPassages(passages(1, 5000), { maxPassages: 40, maxChars: 100 });
    expect(batches.flat()).toHaveLength(1);
  });
});

describe("requestBody — what the wire carries", () => {
  it("sends the kind next to the text, and nothing else about the session", () => {
    const plan = planTranslation([unit("u1", "hallo", "prompt")]);
    expect(requestBody("local", "de", plan.passages)).toEqual({
      engine: "local",
      target: "de",
      units: [{ kind: "prompt", text: "hallo" }],
    });
  });
});

describe("foldMessage — the stream reducer", () => {
  const keys = ["u0#0", "u1#0", "u2#0"];

  it("keeps the meta line", () => {
    const meta = {
      engine: "local",
      provider: "spectro-local",
      model: "qwen3-4b",
      target: "German",
      units: 3,
    };
    expect(foldMessage(EMPTY_FOLD, { meta }, keys).meta).toEqual(meta);
  });

  it("accumulates deltas under the passage's own key", () => {
    let fold = foldMessage(EMPTY_FOLD, { unit: 1, delta: "Hal" }, keys);
    fold = foldMessage(fold, { unit: 1, delta: "lo" }, keys);
    expect(fold.byKey.get("u1#0")).toBe("Hallo");
    expect(fold.byKey.has("u0#0")).toBe(false);
  });

  it("counts and marks a finished passage", () => {
    let fold = foldMessage(EMPTY_FOLD, { unit: 0, delta: "Hallo" }, keys);
    expect(fold.finished).toBe(0);
    fold = foldMessage(fold, { unit: 0, end: true }, keys);
    expect(fold.finished).toBe(1);
    expect(fold.settled.has("u0#0")).toBe(true);
  });

  it("records a failed passage and moves on", () => {
    const fold = foldMessage(EMPTY_FOLD, { unit: 2, error: "rate limited" }, keys);
    expect(fold.failed.get("u2#0")).toBe("rate limited");
    expect(fold.settled.has("u2#0")).toBe(true);
    expect(fold.finished).toBe(1);
    expect(fold.fatal).toBeNull();
  });

  it("treats a terminal error line as the end of the run", () => {
    expect(foldMessage(EMPTY_FOLD, { error: "provider died" }, keys).fatal).toBe("provider died");
  });

  it("ignores a passage index this client never sent", () => {
    expect(foldMessage(EMPTY_FOLD, { unit: 99, delta: "??" }, keys).byKey.size).toBe(0);
  });

  it("never mutates the fold it was given", () => {
    const before = foldMessage(EMPTY_FOLD, { unit: 0, delta: "a" }, keys);
    const after = foldMessage(before, { unit: 0, delta: "b" }, keys);
    expect(before.byKey.get("u0#0")).toBe("a");
    expect(after.byKey.get("u0#0")).toBe("ab");
  });
});

describe("settledUnits — a unit lands only when all of it has come back", () => {
  const plan = planTranslation([unit("u1", `Lies:\n\n\`\`\`\nls -la\n\`\`\`\n\n${"z".repeat(2500)}`)]);

  const fold = (msgs: readonly TranslateMessage[]) => {
    const keys = plan.passages.map((p) => passageKey(p.unitId, p.pieceIndex));
    return msgs.reduce((acc, msg) => foldMessage(acc, msg, keys), EMPTY_FOLD);
  };

  it("holds a unit back while one of its passages is still out", () => {
    expect(plan.passages.length).toBeGreaterThan(2);
    expect(
      settledUnits(
        plan,
        fold([
          { unit: 0, delta: "Read:" },
          { unit: 0, end: true },
        ]),
      ).size,
    ).toBe(0);
  });

  it("hands over the whole unit once every passage settled", () => {
    const all = plan.passages.flatMap((_, i) => [
      { unit: i, delta: `T${i}` },
      { unit: i, end: true },
    ]);
    const done = settledUnits(plan, fold(all));
    expect(done.get("u1")).toContain("T0");
    expect(done.get("u1")).toContain("```\nls -la\n```");
  });

  it("keeps a unit ORIGINAL when one of its passages failed — never half-translated", () => {
    const messages = plan.passages.flatMap((_, i): TranslateMessage[] =>
      i === 1
        ? [{ unit: i, error: "rate limited" }]
        : [
            { unit: i, delta: `T${i}` },
            { unit: i, end: true },
          ],
    );
    expect(settledUnits(plan, fold(messages)).has("u1")).toBe(false);
    expect(failedUnits(plan, fold(messages)).get("u1")).toBe("rate limited");
  });

  it("keeps a unit original when a passage came back empty", () => {
    const empty = plan.passages.flatMap((_, i) => [{ unit: i, end: true }]);
    expect(settledUnits(plan, fold(empty)).has("u1")).toBe(false);
  });

  it("never lets a code-only unit into the map", () => {
    const codeOnly = planTranslation([unit("u9", "```\nls\n```")]);
    expect(settledUnits(codeOnly, EMPTY_FOLD).has("u9")).toBe(false);
  });
});

describe("the per-view store", () => {
  it("starts every view on the chrome language, showing the translation slot", () => {
    const state = translationOf("view-a");
    expect(state.target).toBe(defaultTarget("en"));
    expect(state.status).toBe("idle");
    expect(state.byId.size).toBe(0);
  });

  it("keeps views apart — a replayed archive is not the live session", () => {
    setTarget("view-b", "de");
    expect(translationOf("view-b").target).toBe("de");
    expect(translationOf("view-c").target).toBe(defaultTarget("en"));
  });

  it("remembers the engine choice per view", () => {
    setEngine("view-d", "cloud");
    expect(translationOf("view-d").engine).toBe("cloud");
  });

  it("keeps the original one click away", () => {
    setShow("view-e", "translation");
    expect(translationOf("view-e").show).toBe("translation");
    toggleShow("view-e");
    expect(translationOf("view-e").show).toBe("original");
    toggleShow("view-e");
    expect(translationOf("view-e").show).toBe("translation");
  });
});

describe("translatedEvents — the selector every view folds over", () => {
  const events: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "привіт", ts: 1 },
    { type: "text_delta", agentId: "main", text: "Синє світло", ts: 2 },
  ];

  it("hands back the very same array while nothing is translated", () => {
    const state = { ...emptyTranslation("en"), show: "translation" as const };
    expect(translatedEvents(events, state)).toBe(events);
  });

  it("hands back the very same array when the reader asked for the original", () => {
    const state = { ...emptyTranslation("en"), show: "original" as const, byId: new Map([["u1", "hi"]]) };
    expect(translatedEvents(events, state)).toBe(events);
  });
});

describe("defaultTarget", () => {
  it("follows the UI language", () => {
    expect(defaultTarget("de")).toBe("de");
    expect(defaultTarget("en")).toBe("en");
  });
});

describe("parseTranslateChunk", () => {
  it("splits complete NDJSON lines and keeps the partial tail", () => {
    const first = parseTranslateChunk("", '{"meta":{"engine":"local","units":2}}\n{"unit":0,"delta":"Hal');
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].meta?.engine).toBe("local");
    const second = parseTranslateChunk(first.pending, 'lo"}\n{"unit":0,"end":true}\n');
    expect(second.messages[0].delta).toBe("Hallo");
    expect(second.messages[1].end).toBe(true);
    expect(second.pending).toBe("");
  });

  it("skips a garbled line instead of killing the run", () => {
    expect(parseTranslateChunk("", 'not json\n{"done":true}\n').messages).toEqual([{ done: true }]);
  });
});

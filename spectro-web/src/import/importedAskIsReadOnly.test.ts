// Card 265, criterion 8, against a REAL imported transcript rather than a
// fixture. The rule: a question read out of somebody else's session must carry
// no live control. It was answered months ago, by another person, on another
// machine — and the renderer that draws it keys on the TOOL NAME, so nothing
// about the drawing itself can tell the two apart.
//
// The fixture version of this test would have passed on a reducer that queued
// the question, because a fixture ends where the author decided it ends. A real
// file is where the shape that breaks it lives: an interrupted call whose
// tool_result never came.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseTranscript } from "./claudeCode";
import { initialState, normalizeReplay, reduceAll } from "../state/reducer";

/** The owner's own Claude Code transcripts. Absent on any other machine, and a
 *  test that cannot find its evidence says so instead of passing quietly. */
const CORPUS = join(homedir(), ".claude", "projects", "-Users-christopher-ezell-Spectroscope");

/** A transcript written to within this window may belong to a live session. */
const LIVE_MS = 5 * 60_000;

type Pick =
  { kind: "picked"; name: string; text: string; mtimeMs: number } | { kind: "none"; reason: string };

const foldAsks = (text: string) => {
  const folded = normalizeReplay(reduceAll(initialState, parseTranscript(text)));
  const asks = Object.values(folded.cards).filter((c) => c.name === "AskUserQuestion").length;
  return { folded, asks };
};

/** Card 559: the first transcript in name order that no session is still
 *  writing and whose fold holds an AskUserQuestion call. Naming the tool is not
 *  enough: a session's opening attachments name it before any call is made. */
const pickAskTranscript = (dir: string, nowMs: number): Pick => {
  if (!existsSync(dir)) return { kind: "none", reason: "no transcript folder on this machine" };
  let named = 0;
  let live = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const { mtimeMs } = statSync(path);
    if (nowMs - mtimeMs < LIVE_MS) {
      live++;
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (!text.includes("AskUserQuestion")) continue;
    if (foldAsks(text).asks > 0) return { kind: "picked", name, text, mtimeMs };
    named++;
  }
  return {
    kind: "none",
    reason: `no settled transcript holds an AskUserQuestion call (${named} name the tool without one, ${live} skipped as live)`,
  };
};

describe("an imported question is read-only (card 265, criterion 8)", () => {
  it("carries no pending question after the import folds", (ctx) => {
    const now = Date.now();
    const pick = pickAskTranscript(CORPUS, now);
    if (pick.kind === "none") return ctx.skip(pick.reason);
    const { folded, asks } = foldAsks(pick.text);

    // No running session is still writing the evidence.
    expect(now - pick.mtimeMs, `${pick.name} was written to within ${LIVE_MS} ms`).toBeGreaterThanOrEqual(
      LIVE_MS,
    );

    // The premise: this really is a transcript with an answered question in it.
    expect(asks, `${pick.name} must contain an AskUserQuestion call`).toBeGreaterThan(0);

    // And the rule: nothing in it is waiting on anybody.
    expect(folded.pendingAsks, `pending asks in ${pick.name}`).toEqual([]);
  }, 60_000);
});

// Card 559: which file the test above reads must not depend on the order of the
// folder or on which sessions are running. These cases build the shapes that
// broke it in a temporary folder, so they run on every machine.
describe("the transcript the imported ask test reads (card 559)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spectro-559-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const line = (o: unknown) => JSON.stringify(o);
  const namesTheTool = [
    line({
      type: "user",
      message: { role: "user", content: "Use AskUserQuestion when unsure." },
      uuid: "u1",
      timestamp: "2026-10-12T10:00:00.000Z",
    }),
  ].join("\n");
  const holdsACall = [
    line({
      type: "user",
      message: { role: "user", content: "Pick a colour." },
      uuid: "u1",
      timestamp: "2026-10-12T10:00:00.000Z",
    }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which colour?",
                  header: "Colour",
                  options: [{ label: "red" }, { label: "blue" }],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      },
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-10-12T10:00:01.000Z",
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: 'User answered: "Which colour?"="red"' },
        ],
      },
      uuid: "u2",
      parentUuid: "a1",
      timestamp: "2026-10-12T10:00:02.000Z",
    }),
  ].join("\n");

  const now = Date.now();
  const write = (sub: string, name: string, text: string, ageMs: number) => {
    const path = join(dir, sub, name);
    writeFileSync(path, text);
    const at = (now - ageMs) / 1000;
    utimesSync(path, at, at);
  };

  it("passes a file that only names the tool and a live file, and takes the settled one with a call", () => {
    const sub = "mixed";
    mkdirSync(join(dir, sub));
    write(sub, "a-names-the-tool.jsonl", namesTheTool, 60 * 60_000);
    write(sub, "b-live.jsonl", holdsACall, 0);
    write(sub, "c-settled.jsonl", holdsACall, 60 * 60_000);
    write(sub, "d-settled.jsonl", holdsACall, 60 * 60_000);

    const pick = pickAskTranscript(join(dir, sub), now);
    expect(pick.kind === "picked" ? pick.name : pick.reason).toBe("c-settled.jsonl");
  });

  it("gives a reason instead of a file when no settled file holds a call", () => {
    const sub = "none";
    mkdirSync(join(dir, sub));
    write(sub, "a-names-the-tool.jsonl", namesTheTool, 60 * 60_000);
    write(sub, "b-live.jsonl", holdsACall, 0);

    expect(pickAskTranscript(join(dir, sub), now)).toEqual({
      kind: "none",
      reason:
        "no settled transcript holds an AskUserQuestion call (1 name the tool without one, 1 skipped as live)",
    });
  });
});

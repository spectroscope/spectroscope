// Card 380, fix round 2026-09-24, item 2. Where the steering message is drawn.
//
// The audit of 2026-09-21 found the sentence invisible from the moment it left
// the composer until the loop read it, which can be minutes, and gone for good
// when the run ended first. The decisions (pending, read, missed) live in
// state/steering.ts and the reducer and are pinned there. This file pins the
// wiring no pure test reaches, because this project's vitest runs without a
// DOM: that Chat draws the pending rows inside the transcript, that a drawn
// operator turn says which outcome it was, and that App hands a missed
// sentence back to the waiting line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments } from "../testkit/source";

function code(rel: string): string {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  // Comments blanked, so the prose that explains the wiring cannot stand in
  // for it.
  return blankBlockComments(src).replace(/^\s*\/\/.*$/gm, "");
}

const chat = code("./Chat.tsx");
const app = code("../App.tsx");

/** The source between two anchors, or "" when either is missing. */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start + from.length);
  return end < 0 ? "" : src.slice(start, end);
}

describe("the steering message on the screen", () => {
  it("is drawn as pending inside the transcript, from the page's own list", () => {
    const history = between(chat, 'className="history"', "showWorkingLine(");

    expect(history.length, "the transcript block was found").toBeGreaterThan(0);
    // The list is iterated, not merely named: the first bite of this file cast
    // an empty array to the prop's type and the name alone still matched.
    expect(history).toMatch(/props\.steerPending\??\.map\(/);
    expect(history).toContain('"chat.steerPending"');
  });

  it("says in the bubble whether the run read it or missed it", () => {
    const userCase = between(chat, 'case "user":', 'case "assistant":');

    expect(userCase.length, "the user branch of renderTurn was found").toBeGreaterThan(0);
    expect(userCase).toContain("turn.steer");
    expect(userCase).toContain('"chat.steerDelivered"');
    expect(userCase).toContain('"chat.steerUndelivered"');
  });

  it("gets its pending list from App, and App puts a missed sentence back in line", () => {
    expect(app).toMatch(/steerPending:\s*steeringView\.pending/);
    // What noteFrame hands back goes into the old waiting line (owner call 3),
    // through the same enqueue a queued submit uses.
    const handler = between(app, "noteFrame(", "readSessionBusy(");
    expect(handler).toContain("read.requeue");
    expect(handler).toContain("enqueue(");
  });
});

// The live-session seam, held against the Java that serves it.
//
// Three strings decide whether this feature works at all, and each of them is
// written twice, in files that cannot import each other: the REST path, the
// push frame's type and the refusal frame's type. This house has paid for that
// shape before — nonWire.ts listed socket frames from memory and missed three,
// and a bus stylesheet named 37 tokens that did not exist. A typo here does not
// fail a build; it produces a rail that is simply always empty, which looks
// exactly like "nothing is running".
//
// So the Java is read off disk, the same idiom as wireOnly.drift.test.ts next
// door.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

const CONTROLLER = "spectro-server/src/main/java/dev/spectroscope/server/session/LiveSessionsController.java";
const CONNECTION = "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java";
const REGISTRY = "spectro-server/src/main/java/dev/spectroscope/server/session/LiveSessions.java";

const store = readFileSync(fileURLToPath(new URL("./liveSessions.ts", import.meta.url)), "utf8");

describe("the live-session seam", () => {
  it("polls the path the server actually maps", () => {
    const mapped = /@GetMapping\("([^"]+)"\)/.exec(java(CONTROLLER));
    expect(mapped, "LiveSessionsController no longer maps anything").not.toBeNull();
    expect(store).toContain(`"${mapped![1]}"`);
  });

  it("reads the frame types the connection actually sends", () => {
    const frames = new Set([...java(CONNECTION).matchAll(/"type",\s*"([a-z_]+)"/g)].map((match) => match[1]));
    expect(frames.has("live_sessions"), "the connection stopped pushing the live set").toBe(true);
    expect(frames.has("session_busy"), "the connection stopped refusing a taken session").toBe(true);
    expect(store).toContain('!== "live_sessions"');
    expect(store).toContain('!== "session_busy"');
  });

  it("reads the field names the record actually serialises", () => {
    // The row is a Java record, so Jackson writes its component names verbatim.
    const record = /record LiveSession\(([^)]*)\)/.exec(java(REGISTRY));
    expect(record, "LiveSessions.LiveSession is gone").not.toBeNull();
    for (const component of record![1].split(",")) {
      const field = component.trim().split(/\s+/)[1];
      expect(store, `the store never reads ${field}`).toContain(`${field}:`);
    }
  });

  it("refuses the second socket rather than sharing the file", () => {
    // Acceptance criterion 4, in writing AND in code. If this ever flips to
    // "made safe", it is a decision somebody has to make on purpose — and the
    // client's copy, which tells the reader to close the other window, has to
    // change in the same breath.
    expect(java(CONNECTION)).toContain("!liveSessions.claim(socket.getId(), resumeId)");
    expect(java(CONNECTION)).toContain("sendSessionBusy(resumeId)");
  });
});

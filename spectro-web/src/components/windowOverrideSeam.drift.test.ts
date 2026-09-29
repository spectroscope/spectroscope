// Card 390, review of 2026-09-24 (second round): the last link from the ring
// to the socket is one line in App.tsx, and nothing pinned it.
//
// windowOverridePath.test.tsx presses Set and Clear in the header's ring and
// proves the press reaches the handler App hands the header. What App does
// with it is this line. Replaced by a handler that builds the frame and never
// sends it, it kept tsc and all 463 files green (evidence 390/fix-2026-09-24/
// round2, 03-gap-full-suite.log). App.tsx cannot be rendered in this suite
// (it opens a websocket and owns the whole shell), so the line is read off
// disk, the pattern dockFocusSeam.drift.test.ts uses for its App.tsx seam.
// The frame the line builds is pinned in wire/windowOverride.test.ts.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
// Cards 458 and 459: the socket is a record's in the session set.
const set = stripComments(read("../state/sessionSet.ts", import.meta.url));

/**
 * The JSX element `<Name … />` as text, from its first mount.
 *
 * Asserted to exist and to close: a slice that quietly returned "" would make
 * every check below green against nothing.
 */
function element(src: string, name: string): string {
  const from = src.indexOf(`<${name}`);
  expect(from, `<${name} must be mounted`).toBeGreaterThan(-1);
  const to = src.indexOf("/>", from);
  expect(to, `<${name} must be a self-closing element`).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("App sends the window set in the header's ring on the session socket", () => {
  it("has the one AppHeader mount this file knows about", () => {
    expect(app.split("<AppHeader").length - 1).toBe(1);
  });

  it("turns a set or a clear into the frame and sends it", () => {
    expect(element(app, "AppHeader")).toContain(
      "onWindowOverride={(tokens) => sendClient(windowOverrideFrame(tokens))}",
    );
  });

  it("builds the frame with the wire module's builder", () => {
    // The premise of the check above: a local function of the same name would
    // make that string an assertion about a builder nothing tests.
    expect(app).toContain('import { windowOverrideFrame } from "./wire/windowOverride";');
  });

  it("and sendClient hands the frame to the connection", () => {
    const head = "const sendClient = useCallback(";
    const from = app.indexOf(head);
    expect(from, "sendClient must be declared in this form").toBeGreaterThan(-1);
    const to = app.indexOf("[sessions],", from);
    expect(to, "sendClient's body must close").toBeGreaterThan(from);
    // App hands the frame to the record in view, and the record to its socket.
    expect(app.slice(from, to)).toContain("sessions.sendClient(sessions.view().key, msg)");
    const inSet = set.slice(
      set.indexOf("sendClient(key: string, msg: ClientMessage)"),
      set.indexOf("sendNow("),
    );
    expect(inSet).toContain("const sent = record.connection?.send(msg) === true;");
  });
});

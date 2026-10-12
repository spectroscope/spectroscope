// Card 504, hub and spoke review round 2: App's side of the two findings
// state/resumeJoin.test.ts and state/sessionFrames.test.ts pin in behaviour.
// App has no runtime test in this suite (no DOM, house rule), so its glue is
// read from the source: a gear frame on a stored session first tries to join
// the resume in flight, resumeSession carries and hands on every joined frame,
// and the leveling beacons ride onSent, where every frame that reaches the
// wire passes, not the sendClient wrapper that the drain of a continued
// session never calls.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));

/** The text of the arrow function assigned to `const name`, up to its closing `};`. */
function arrow(source: string, name: string): string {
  const at = source.indexOf(`const ${name} = `);
  if (at < 0) throw new Error(`${name} is not in App`);
  const end = source.indexOf("\n  };\n", at);
  return source.slice(at, end + 5);
}

describe("App joins gear frames to the resume in flight", () => {
  it("sessionFrame tries the join before it starts a resume", () => {
    const body = arrow(app, "sessionFrame");
    const joined = body.indexOf("resumeJoin.join(replay.id, frame)");
    const resumed = body.indexOf("resumeSession(replay.id, { frame })");
    expect(joined, "the join").toBeGreaterThan(0);
    expect(resumed, "the resume").toBeGreaterThan(0);
    expect(joined).toBeLessThan(resumed);
  });

  it("resumeSession carries before its ticket, begins after it, and hands every frame on", () => {
    const body = arrow(app, "resumeSession");
    const carried = body.indexOf("resumeJoin.carried(id)");
    const issued = body.indexOf("navNonce.issue()");
    const begun = body.indexOf("resumeJoin.begin(id, ticket,");
    expect(carried).toBeGreaterThan(0);
    expect(carried).toBeLessThan(issued);
    expect(begun).toBeGreaterThan(issued);
    expect(body).toMatch(/firstFrames: resumeJoin\.take\(ticket\)/);
    expect(body, "no single frame slot left").not.toMatch(/firstFrame:/);
  });

  it("a failed fetch drops the frames its resume held", () => {
    const body = arrow(app, "resumeSession");
    const failed = body.slice(body.indexOf("} catch {"));
    expect(failed).toMatch(
      /^\} catch \{\s*for \(const frame of resumeJoin\.take\(ticket\)\) sentWrites\.drop\(id, frame\);/,
    );
  });
});

describe("the leveling beacons ride onSent", () => {
  it("the SessionSet is built with onSent", () => {
    expect(app).toMatch(/onSent: \(key, msg\) => sentSink\.current\(key, msg\)/);
  });

  it("the gate and permission-mode beacons are in the sink, and nowhere else", () => {
    const sink = app.slice(app.indexOf("sentSink.current = "), app.indexOf("sentSink.current = ") + 600);
    expect(sink).toContain('beaconRef.current("gate")');
    expect(sink).toContain('beaconRef.current("permission-mode")');
    expect(app.match(/beaconRef\.current\("permission-mode"\)/g) ?? []).toHaveLength(1);
    expect(app.match(/beaconRef\.current\("gate"\)/g) ?? []).toHaveLength(1);
  });

  // Last fix round: the gear's project-file write is released here, by the
  // session of the record whose socket the frame reached.
  it("the sink releases the writes held for a frame, keyed by the record's session", () => {
    const sink = app.slice(app.indexOf("sentSink.current = "), app.indexOf("sentSink.current = ") + 600);
    expect(sink).toMatch(
      /sentWrites\.sent\(sessions\.slots\(\)\.find\(\(held\) => held\.key === key\)\?\.sessionId \?\? null, msg\)/,
    );
    expect(app.match(/sentWrites\.sent\(/g) ?? []).toHaveLength(1);
  });
});

// Card 504, final round of 2026-10-12: every exit of resumeSession that
// abandons its frames drops them and their held writes: the two early returns
// when a later navigation won, and the catch. Textual: the resume runs only
// inside App with a live fetch, so there is no DOM pin for these exits.
describe("an abandoned resume drops its frames", () => {
  it("drops at both early returns and in the catch", () => {
    const start = app.indexOf("const resumeSession");
    const end = app.indexOf("const canResume");
    expect(start, "positive: resumeSession is in App").toBeGreaterThan(-1);
    const body = app.slice(start, end);
    expect(
      body.match(/for \(const frame of resumeJoin\.take\(ticket\)\) sentWrites\.drop\(id, frame\);/g) ?? [],
    ).toHaveLength(3);
    expect(body).not.toMatch(
      /if \(!navNonce\.isCurrent\(ticket\)\) return;\s*\/\/ a later navigation already won/,
    );
    expect(body).not.toMatch(/if \(folded === null\) return;/);
  });
});

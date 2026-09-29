// Card 430, criteria 5 to 7: the six gates are functions in state/modeWork.ts,
// tested with a learn twin each in modeWork.test.ts. A gate nobody calls ships
// dead, so this file pins the lines in App that call them, read off disk with
// the comments blanked (the suite has no DOM).

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
// Cards 458 and 459: the fold, the event list and the outgoing trace row moved
// into the session set, one record per socket. App still routes the side effects.
const set = stripComments(read("./sessionSet.ts", import.meta.url));

/** The body of `const name = ...` in App, up to its closing line. */
function fn(name: string, close = "\n  };\n"): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf(close, at));
}

describe("the socket batch (gates 1, 3 and 4)", () => {
  const sinkAt = app.indexOf("  batchSink.current = ");
  const sink = app.slice(sinkAt, app.indexOf("\n  };\n", sinkAt));
  const setBatch = set.slice(set.indexOf("private onEvents("), set.indexOf("private drain("));

  it("reads the mode at call time, and folds and feeds with it", () => {
    expect(app).toContain("mode: currentViewMode,");
    expect(app).toContain("traceWanted: currentLiveTraceWanted,");
    expect(setBatch).toContain(
      "foldLiveBatch(before.state, batch, this.deps.mode(), this.deps.traceWanted())",
    );
    expect(sink).toMatch(/const mode = currentViewMode\(\);/);
    expect(sink).toContain("feedSurfaceStores(batch, mode, {");
  });

  it("feeds the Lab and the fleet store nowhere else", () => {
    expect(app).not.toMatch(/\blabPushLive\(/);
    expect(app).not.toMatch(/\bfleetPushLive\(/);
  });

  it("keeps the full event list in both modes, for export and translate (criterion 6)", () => {
    // Unconditional: no mode test stands between the batch and the list.
    expect(setBatch).toContain("events: [...before.events, ...batch],");
    const before = setBatch.slice(0, setBatch.indexOf("events: [...before.events"));
    expect(before).not.toMatch(/\bif \(\s*this\.deps\.mode/);
    // App keeps no second copy of the list: it reads the record's.
    expect(app).toContain("const liveEvents = slot.events;");
    expect(app).not.toMatch(/setLiveEvents\(/);
    // And the chat, whose export and translate read it, is handed that list.
    expect(app).toMatch(/viewingLive \? liveEvents : \(replay\?\.events \?\? \[\]\)/);
    expect(app).toMatch(/events: tabEvents,/);
  });
});

describe("a frame this window sends (gate 1)", () => {
  it("records its row through the mode's fold", () => {
    const send = set.slice(
      set.indexOf("sendClient(key: string, msg: ClientMessage)"),
      set.indexOf("sendNow("),
    );
    expect(send).toContain(
      "recordLiveOutgoing(record.slot.state, msg, this.deps.mode(), this.deps.traceWanted())",
    );
    expect(fn("sendClient", "\n  );\n")).toContain("sessions.sendClient(sessions.view().key, msg)");
    expect(app).not.toMatch(/\brecordOutgoing\(/);
    expect(set).not.toMatch(/\brecordOutgoing\(/);
  });
});

describe("the warm-up (gate 2)", () => {
  it("is armed by traceReachableIn with the mode", () => {
    expect(fn("traceReachable", ");\n")).toMatch(/traceReachableIn\(\{\s*mode: viewMode,/);
  });
});

describe("the roster (gate 5)", () => {
  it("is fetched at a socket's start through the gate", () => {
    expect(app).toContain("fetchFleetRosterIn(currentViewMode());");
    // The one direct call left is a fleet deep link, which light has already
    // rewritten to the live default before applyRoute runs (modeRoute.ts).
    expect(app.split("hydrateFleet(").length - 1).toBe(1);
    expect(fn("applyRoute")).toContain("await hydrateFleet();");
  });
});

describe("the index (gate 6)", () => {
  it("is asked for by a resume only where the mode wants it", () => {
    expect(fn("resumeSession")).toContain("indexWanted(mode) ? fetchLlmWireIndex(id) : Promise.resolve([]),");
  });

  it("offers the sidecar link only where the mode wants the index (owner call 8)", () => {
    expect(app).toMatch(/llmWireId:\s*wantIndex &&/);
  });
});

describe("the resume", () => {
  const resume = fn("resumeSession");

  it("folds through the mode, marks the trace only where it is open, and follows a switch made meanwhile", () => {
    expect(resume).toContain("const mode = currentViewMode();");
    expect(resume).toMatch(/await foldResume\(events, mode, \{/);
    expect(resume).toMatch(/let seeded = isOpen\("trace", mode\)\s*\?\s*recordResumeMarker\(/);
    expect(resume).toMatch(
      /if \(now !== mode\) \{\s*seeded = isOpen\("trace", now\)\s*\?\s*returnToLearn\(seeded, events, currentLiveTraceWanted\(\)\)\s*:\s*enterLight\(seeded\);/,
    );
  });

  it("seeds the Lab only where it is open (gate 3)", () => {
    expect(resume).toContain('if (isOpen("lab", now)) labBackToLive(events);');
    expect(resume).toMatch(/sessions\.open\(\{[\s\S]*?\n\s*events,\n/);
  });
});

describe("the Lab's re-seed on a translation", () => {
  it("waits where the Lab is closed (gate 3)", () => {
    expect(app).toMatch(/seededRef\.current === labSeed \|\| !isOpen\("lab", viewMode\)\)\s*return;/);
  });
});

describe("the switch (criteria 4 and 7)", () => {
  it("runs applyModeSwitch from one store listener, subscribed once", () => {
    expect(app).toContain(
      "useEffect(() => subscribeViewMode(() => applyModeSwitch(currentViewMode(), modeSwitchDeps.current)), []);",
    );
  });

  it("hands it the list at call time, the Lab's two seeds and the roster gate", () => {
    const deps = app.slice(
      app.indexOf("modeSwitchDeps.current = {"),
      app.indexOf("\n  };\n", app.indexOf("modeSwitchDeps.current = {")),
    );
    expect(deps).toContain("liveEvents: () => sessions.view().events,");
    expect(deps).toContain("lab: { reset: labResetLive, backToLive: labBackToLive },");
    expect(deps).toContain("fetchFleetRoster: () => fetchFleetRosterIn(currentViewMode()),");
    expect(deps).toContain('if (landing.route !== null) commitUrl(landing.route, "apply");');
  });
});

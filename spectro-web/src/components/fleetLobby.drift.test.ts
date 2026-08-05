// Card 179: the fleets segment has to REACH the surface, and the bus has to
// draw before it has traffic.
//
// These are drift tests reading the files off disk, the same shape as
// componentReach.drift.test.ts and settingsOpenWrites.drift.test.ts, because
// App.tsx has no render harness here. They pin the two wirings whose absence
// was invisible: a private useState that nothing outside could observe, and an
// early return that removed the one surface a reader came to look at.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string): string => readFileSync(join(__dirname, "..", p), "utf8");

describe("the fleets segment reaches App", () => {
  const sidebar = src("components/Sidebar.tsx");
  const app = src("App.tsx");

  it("does not keep the segment in a useState of its own", () => {
    // While it did, pressing `fleets` re-rendered one list body and told
    // nothing else — "wenn ich in den Fleet Modus gehe, dann bleibt alles so,
    // wie es ist". The state belongs where the surface can answer it.
    expect(sidebar).not.toMatch(/useState<\s*"sessions"\s*\|\s*"fleets"\s*>/);
    expect(sidebar).toMatch(/const nav = props\.nav;/);
    expect(sidebar).toMatch(/props\.onNav\("fleets"\)/);
    expect(sidebar).toMatch(/props\.onNav\("sessions"\)/);
  });

  it("owns the segment in App and hands it down", () => {
    expect(app).toMatch(/const \[nav, setNav\] = useState<"sessions" \| "fleets">\("sessions"\)/);
    expect(app).toMatch(/nav=\{nav\}/);
    expect(app).toMatch(/onNav=\{setNav\}/);
  });

  it("follows the surface when a fleet is entered by address", () => {
    // A pasted #/fleet/{id} used to enter the fleet while the sidebar still
    // read Sessions, because nothing could reach the segment.
    const applyFleet = app.slice(app.indexOf("const applyFleet"));
    expect(applyFleet.slice(0, 600)).toMatch(/setNav\("fleets"\)/);
  });

  it("leaves the segment when the ladder locks fleets", () => {
    expect(app).toMatch(/if \(fleetsLocked\) setNav\("sessions"\)/);
  });

  it("renders the lobby for the segment with nothing entered", () => {
    expect(app).toMatch(/nav === "fleets" && enteredFleet === null \? \(\s*<FleetLobby/);
    // And the app's own tabs are suppressed there: chat/spectrum/trace describe
    // the live session and mean nothing while the reader is looking at fleets.
    expect(app).toMatch(/nav === "fleets" && enteredFleet === null \? null/);
  });
});

describe("the bus draws before it has traffic", () => {
  const bus = src("spectrum/FleetBus.tsx");
  const css = src("styles/bus.css");

  it("has no early return that replaces the rail with a sentence", () => {
    // The rail IS what the reader came to see. Replacing it meant the surface
    // that explains this app only appeared once it no longer needed to.
    expect(bus).not.toMatch(/if \(ordered\.length === 0\) \{\s*return/);
  });

  it("keeps the empty sentence, on the rail rather than instead of it", () => {
    const railAt = bus.indexOf('className="bus-rail"');
    const emptyAt = bus.indexOf('className="bus-empty"');
    expect(railAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(bus).toMatch(/ordered\.length === 0 && <p className="bus-empty">/);
  });

  it("holds the card row open so the rail does not sink to the floor", () => {
    // .bus-scroll is justify-content: flex-end; with no cards the row would
    // collapse to nothing and take the rail down with it.
    expect(bus).toMatch(/bus-cards--empty/);
    expect(css).toMatch(/\.bus-cards--empty\s*\{[^}]*min-height/);
  });
});

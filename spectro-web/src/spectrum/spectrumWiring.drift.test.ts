// How the Spectrum's window and the band's wheel are WIRED, read off disk.
//
// The arithmetic is pure and pinned next door. What no unit test in a suite
// without a DOM can see is the .tsx line that composes it, and all three defects
// below lived exactly there:
//
//   - the readout asked whether the state slot had ever been written instead of
//     whether the window is narrower than the whole, so pressing "all" printed
//     the total span twice and never stopped.
//   - the raw setter was handed to three children, so "all" stored the pair
//     {0,1} where the view documents null as the only way to say "the whole";
//     the next arriving event rebased that pair and the button lit up again.
//   - the band scaled deltaX into its 1000-unit viewBox and compared it against
//     a raw deltaY, so the same trackpad swipe panned on a laptop and scrolled
//     the page on a wide monitor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const view = read("./SpectrumView.tsx");
const band = read("./SpectrumBand.tsx");
const strip = read("./SpectrumStrip.tsx");
const css = read("../styles/spectrum.css");

/** Every declaration block in a stylesheet, as {selector, body} pairs. Crude on
 *  purpose: this file has no nested at-rules, and a real parser would be a
 *  dependency for four assertions. */
function rules(sheet: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(sheet);
  while (m !== null) {
    out.push({ selector: m[1].trim().split("\n").pop()!.trim(), body: m[2] });
    m = re.exec(sheet);
  }
  return out;
}

describe("the window readout", () => {
  it("asks the window, not the state slot, whether the reader has left the whole", () => {
    const line = view.split("\n").find((l) => l.includes("sp.ofSpan"));
    expect(line).toContain("isWhole(win)");
    expect(line).not.toContain("winState !== null");
  });
});

describe("one rule stores the window", () => {
  it("hands no child the raw setter, so the buttons and the keys cannot drift", () => {
    expect(view).not.toContain("setWinState}");
    expect(view).not.toContain("? setWinState :");
  });

  it("keeps exactly one writer, and it goes through the sentinel rule", () => {
    expect(view.split("setWinState(").length - 1).toBe(1);
    expect(view).toContain("setWinState(storeWindow(");
  });
});

// The control and its readout are at opposite ends of one scroll box: the scrub
// bar sits above 837px of lanes, the clock below them. On a 287px window the
// reader gets one or the other and, in a measured 500px band of scrollTop,
// neither. Two pinned edges answer it, and the rules below are what keeps the
// answer from rotting: exactly one sticky element per edge, no offset that is
// anything but zero, and the toolbar deliberately NOT pinned, because it wraps
// from 22px to 55px under 800px of width and any offset measured against it
// would then eat two thirds of the scrub bar.
describe("the two pinned edges", () => {
  it("pins the strip row to the top of the scroller and the axis row to the bottom", () => {
    const head = rules(css).find((r) => r.selector.includes("spectrum-viewport-row--head"));
    const foot = rules(css).find((r) => r.selector.includes("spectrum-viewport-row--foot"));
    expect(head?.body).toContain("position: sticky");
    expect(head?.body).toMatch(/\btop:\s*0\s*;/);
    expect(foot?.body).toContain("position: sticky");
    expect(foot?.body).toMatch(/\bbottom:\s*0\s*;/);
  });

  it("leaves the toolbar scrolling, so its wrap cannot cover a pinned row", () => {
    const toolbar = rules(css).find((r) => r.selector === ".spectrum-toolbar");
    expect(toolbar?.body ?? "").not.toContain("sticky");
  });

  it("measures no sticky offset against another row's height", () => {
    for (const r of rules(css)) {
      if (!r.body.includes("position: sticky")) continue;
      // The lookbehind is the point: `border-bottom` is not an inset.
      for (const m of r.body.matchAll(/(?<![\w-])(top|bottom):\s*([^;]+);/g)) {
        expect(`${r.selector} ${m[1]}: ${m[2].trim()}`).toBe(`${r.selector} ${m[1]}: 0`);
      }
    }
  });

  it("draws the separation with a line, and adds no second shadow", () => {
    const head = rules(css).find((r) => r.selector.includes("spectrum-viewport-row--head"));
    const foot = rules(css).find((r) => r.selector.includes("spectrum-viewport-row--foot"));
    expect(head?.body).toContain("border-bottom: 1px solid var(--border)");
    expect(foot?.body).toContain("border-top: 1px solid var(--border)");
    // The one shadow in this sheet is .spectrum-tip, flagged as an open owner
    // call. Pinning a row is not a licence to open a second.
    expect(css.split("box-shadow").length - 1).toBe(1);
  });

  it("gives both pinned rows a ground, so lane cards cannot slide through them", () => {
    for (const name of ["--head", "--foot"]) {
      const rule = rules(css).find((r) => r.selector.includes(`spectrum-viewport-row${name}`));
      expect(rule?.body).toContain("background: var(--bg)");
    }
  });
});

describe("the zoom travels with the surface it moves", () => {
  it("renders inside the pinned strip row, not in the toolbar that scrolls away", () => {
    const toolbar = view.slice(
      view.indexOf('className="spectrum-toolbar"'),
      view.indexOf('className="spectrum-viewport-row'),
    );
    expect(toolbar).not.toContain("<ZoomControls");
    expect(view.indexOf("<ZoomControls")).toBeGreaterThan(view.indexOf("spectrum-viewport-row--head"));
  });
});

describe("the wheel gesture", () => {
  // It moved out of SpectrumBand into useWheelZoom, so the STRIP can have the
  // same gesture (owner: ⌘+wheel worked over a lane and nowhere else). The
  // property this pins did not move with it — it just has one home now instead
  // of one home and a copy waiting to be written.
  const hook = read("./useWheelZoom.ts");

  it("settles the axis on the raw deltas, in one space", () => {
    // Scaling deltaX into a drawing's coordinates and comparing it against a
    // raw deltaY decides which axis owns the gesture by how wide that drawing
    // happens to be rendered. At a narrow band it claims a vertical swipe and
    // traps the page scroll the handler exists to leave alone.
    const from = hook.indexOf("wheelToIntent(");
    const call = hook.slice(from, hook.indexOf(");", from));
    expect(call).toContain("e.deltaX");
    expect(call).toContain("e.deltaY");
    expect(call).toContain("innerWidthPx");
    expect(call).not.toContain("viewBoxX");
  });

  it("is bound once, and non-passively", () => {
    // A passive listener cannot preventDefault, so ⌘+wheel would zoom the band
    // AND the browser. Rebinding it per window change drops events mid-gesture,
    // which reads as the zoom stuttering — hence the ref and the empty deps.
    expect(hook).toContain("{ passive: false }");
    expect(hook).toContain("latest.current");
  });

  it("is on BOTH surfaces, so the pointer does not have to know where to be", () => {
    expect(band).toContain("useWheelZoom(");
    expect(strip).toContain("useWheelZoom(");
    // And neither of them grew a second gesture of its own.
    expect(band).not.toContain("wheelToIntent(");
    expect(strip).not.toContain("wheelToIntent(");
  });

  it("hands the band its own drawing units for the anchor only", () => {
    // The anchor is a POSITION in the drawing, so it converts; the deltas and
    // the width they are weighed against never do.
    const from = band.indexOf("useWheelZoom(");
    const call = band.slice(from, band.indexOf("});", from));
    expect(call).toContain("viewBoxX(");
    expect(call).toContain("innerWidthPx(");
    expect(call).not.toContain("e.deltaX");
  });
});

describe("the zoom is stepless", () => {
  it("offers no + and no − knob", () => {
    // Owner 2026-08-05: "keine knubbel … wie im musik programm stufenlos rein
    // und rauszoomen". Two buttons offering fixed halves and doubles beside an
    // exponential wheel taught the wrong model of what the zoom is.
    const from = view.indexOf("const buttons:");
    const list = view.slice(from, view.indexOf("];", from));
    expect(list).not.toContain('key: "in"');
    expect(list).not.toContain('key: "out"');
    // `fit` stays: a stepless zoom needs a way home more than a stepped one,
    // and it is a destination rather than an increment.
    expect(list).toContain('key: "fit"');
  });

  it("does not wait for a reader to be lost before it appears", () => {
    // needsViewport answers "when is a reader LOST" and was the wrong question
    // for "is there an instrument here": on a 123-event session nothing showed.
    expect(view).not.toContain("needsViewport(");
  });

  it("is simply always there, on any stream with a lane", () => {
    // Owner: "die scrubbing zoom ui bitte immer einblenden. auch wenn es nur
    // eine kurze interaktion ist". A control that moves depending on how much
    // happened is one a reader cannot build a habit around.
    expect(view).toContain("const zoomable = model.lanes.length > 0;");
  });
});

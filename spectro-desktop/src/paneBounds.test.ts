import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isUsable, MIN_PANE, paneBounds, toDeviceRect } from "./paneBounds";

const WINDOW = { width: 1200, height: 800 };

describe("paneBounds", () => {
  it("takes the rectangle the web UI measured when it fits", () => {
    const bounds = paneBounds({ x: 320, y: 56, width: 860, height: 700 }, WINDOW);
    assert.deepEqual(bounds, { x: 320, y: 56, width: 860, height: 700 });
  });

  it("keeps the pane inside the window when the report is stale", () => {
    // The window shrank between the report and the paint. Without this the pane
    // hangs off the edge and the operator watches nothing.
    const bounds = paneBounds({ x: 900, y: 700, width: 860, height: 700 }, { width: 1000, height: 760 });
    assert.ok(bounds.x + bounds.width <= 1000, JSON.stringify(bounds));
    assert.ok(bounds.y + bounds.height <= 760, JSON.stringify(bounds));
  });

  it("never paints a pane too small for a page to lay out in", () => {
    const bounds = paneBounds({ x: 0, y: 0, width: 10, height: 10 }, WINDOW);
    assert.equal(bounds.width, MIN_PANE.width);
    assert.equal(bounds.height, MIN_PANE.height);
  });

  it("falls back to the right-hand region when the page has not reported yet", () => {
    const bounds = paneBounds(null, WINDOW);
    assert.ok(bounds.width >= MIN_PANE.width);
    assert.ok(bounds.x > 0, "the fallback leaves the rail visible");
    assert.ok(bounds.x + bounds.width <= WINDOW.width);
  });

  it("rejects a rectangle that is not worth acting on", () => {
    assert.equal(isUsable(null), false);
    assert.equal(isUsable({ x: 0, y: 0, width: 4, height: 4 }), false);
    assert.equal(isUsable({ x: Number.NaN, y: 0, width: 800, height: 600 }), false);
    assert.equal(isUsable({ x: 10, y: 10, width: 800, height: 600 }), true);
  });
});

describe("toDeviceRect — the units seam", () => {
  // THE DEFECT, measured on the owner's own machine on 2026-08-30. He reported
  // a loaded page rendering BESIDE its panel rather than inside it. The page
  // measures its hole with getBoundingClientRect, which returns CSS pixels;
  // `layout()` hands that straight to setBounds, which positions in DIP. At
  // zoomFactor 1 the two are the same number, which is why this shipped and why
  // nobody saw it. His profile carries
  //   per_host_zoom_levels = { "127.0.0.1": 0.5 }
  // and Chromium's zoomFactor is 1.2 ** level, so his app runs at 1.0954 — every
  // reported x lands about 9.5 % short, which paints the pane LEFT of its hole,
  // and further left the further right the panel sits.

  it("is the identity at zoom 1, which is why the bug hid", () => {
    const r = { x: 900, y: 60, width: 600, height: 700 };
    assert.deepEqual(toDeviceRect(r, 1), r);
  });

  it("scales a CSS rectangle into the DIP the shell positions in", () => {
    // 1.2 ** 0.5, the owner's measured factor.
    const z = 1.2 ** 0.5;
    const out = toDeviceRect({ x: 900, y: 60, width: 600, height: 700 }, z);
    assert.equal(out.x, Math.round(900 * z));
    assert.equal(out.y, Math.round(60 * z));
    assert.equal(out.width, Math.round(600 * z));
    assert.equal(out.height, Math.round(700 * z));
    // The number that matters: the pane used to land here, 86 px to the left.
    assert.ok(out.x - 900 > 80, `expected a visible shift, got ${out.x - 900}`);
  });

  it("grows the error with x, which is the shape of the owner's screenshot", () => {
    // A panel on the right is displaced more than one on the left. Pinned
    // because it is the observable signature: the panel chrome and the page
    // drift apart as the panel moves right.
    const z = 1.2 ** 0.5;
    const near = toDeviceRect({ x: 300, y: 0, width: 400, height: 400 }, z).x - 300;
    const far = toDeviceRect({ x: 1100, y: 0, width: 400, height: 400 }, z).x - 1100;
    assert.ok(far > near * 3, `near ${near}, far ${far}`);
  });

  it("refuses a factor that is not a usable number, rather than painting NaN", () => {
    // getZoomFactor cannot normally return these, but a pane positioned at NaN
    // is invisible with no error anywhere, and that is worse than ignoring a
    // bad reading. Every branch separately, because one guard covering four
    // inputs is one guard nobody can bite.
    const r = { x: 900, y: 60, width: 600, height: 700 };
    assert.deepEqual(toDeviceRect(r, Number.NaN), r);
    assert.deepEqual(toDeviceRect(r, 0), r);
    assert.deepEqual(toDeviceRect(r, -1), r);
    assert.deepEqual(toDeviceRect(r, Number.POSITIVE_INFINITY), r);
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isUsable, MIN_PANE, paneBounds } from "./paneBounds";

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

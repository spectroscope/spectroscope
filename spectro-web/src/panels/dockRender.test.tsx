// Card 219, first cut — what the dock RENDERS. The owner's own scoping: each
// surface stands on its own panel, shows and hides independently, collapses
// without dying, and the browser is one of them.
//
// renderToStaticMarkup, the house idiom (sessionRowDensity.test.tsx says why):
// the suite runs in plain Node, so these assertions are about output markup.
// No effect runs here — persistence and the viewport POST are pinned by the
// layout store's own tests and the drift tests beside this file.

import { describe, expect, it, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RightPanel } from "../components/RightPanel";
import { __resetForTests, toggleDockCollapse, toggleDockPanel } from "../state/layout";

beforeEach(() => __resetForTests());

const base = {
  agents: [],
  plan: null,
  onClose: () => {},
  thinking: true,
  workspace: null,
  sessionId: null as string | null,
};

function render(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(<RightPanel {...base} {...extra} />);
}

/** All data-panel ids present in the markup, in DOM order. */
function panelsIn(html: string): string[] {
  return [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("each surface stands on its own", () => {
  it("opens with the roster panel alone — the face the app has always had", () => {
    expect(panelsIn(render())).toEqual(["agents"]);
  });

  it("offers a toggle per panel; work only when the v2 reading offers it", () => {
    const v1 = render();
    // Six toggles (no work), each carrying its pressed state.
    expect(count(v1, "dock-toggle")).toBeGreaterThanOrEqual(6);
    expect(count(v1, 'aria-pressed="true"')).toBe(1); // agents only
    const v2 = render({ work: [] });
    expect(count(v2, "dock-toggle")).toBeGreaterThan(count(v1, "dock-toggle"));
  });

  it("shows several panels at once, stacked", () => {
    toggleDockPanel("plan");
    toggleDockPanel("files");
    expect(panelsIn(render())).toEqual(["agents", "plan", "files"]);
  });

  it("closing one panel leaves the rest standing", () => {
    toggleDockPanel("plan");
    toggleDockPanel("files");
    toggleDockPanel("plan"); // close it again
    expect(panelsIn(render())).toEqual(["agents", "files"]);
  });

  it("keys every section by its panel id, so a toggle never remounts a sibling", () => {
    // Keyed JSX children tie identity to the id rather than to the ordinal
    // position — that is what keeps the terminal's PTY alive when a panel
    // above it closes. Keys never reach the markup, so this is pinned in
    // dockSeparation.drift.test.ts; here we pin the stable order instead.
    toggleDockPanel("terminal");
    toggleDockPanel("context");
    expect(panelsIn(render())).toEqual(["agents", "context", "terminal"]);
  });
});

describe("collapse hides, it does not unmount", () => {
  it("keeps a collapsed panel's body in the tree with display:none", () => {
    toggleDockCollapse("agents");
    const html = render();
    expect(html).toContain("dock-panel--collapsed");
    // The body is still there — hidden, not gone. Unmounting here is the
    // 955 ms trace lesson (card 175) and would kill a terminal's shell.
    expect(html).toContain('style="display:none"');
    expect(count(html, "dock-panel-body")).toBe(1);
  });

  it("says which way its fold control points", () => {
    const open = render();
    expect(open).toContain('aria-expanded="true"');
    __resetForTests();
    toggleDockCollapse("agents");
    expect(render()).toContain('aria-expanded="false"');
  });
});

describe("the divider between expanded neighbours", () => {
  it("stands between two expanded panels, keyboard reachable", () => {
    toggleDockPanel("plan");
    const html = render();
    expect(count(html, 'role="separator"')).toBe(1);
    expect(html).toMatch(/role="separator"[^>]*tabindex="0"/);
  });

  it("leaves with the pair: a collapsed neighbour needs no divider", () => {
    toggleDockPanel("plan");
    toggleDockCollapse("agents");
    expect(count(render(), 'role="separator"')).toBe(0);
  });
});

describe("the browser is one of them", () => {
  it("renders the browser panel with the hole and a fullscreen control", () => {
    toggleDockPanel("browser");
    const html = render();
    expect(panelsIn(html)).toContain("browser");
    expect(html).toContain("browser-hole");
    expect(html).toContain("dock-full-btn");
  });

  it("gives no other panel a fullscreen control", () => {
    const html = render();
    expect(html).not.toContain("dock-full-btn");
  });
});

describe("an empty dock says so", () => {
  it("offers the strip and a sentence instead of a blank column", () => {
    toggleDockPanel("agents");
    const html = render();
    expect(panelsIn(html)).toEqual([]);
    expect(html).toContain("dock-empty");
  });
});

// Card 442 (owner, 2026-09-25 and 2026-09-29): the header keeps its menu and
// nothing else with an icon. Every panel, the side panel itself, the keyboard
// shortcuts and spectro doctor are rows of the ⋮ menu, each with its icon and
// its name; the tools stand apart at the bottom.
//
// Card 228's rule still holds: the rows are the SECOND door to the same
// `spectroscope:layout` truth the dock strip reads. renderToStaticMarkup
// against the real store pins that; the click wiring is read at the source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderMenu, HEADER_MENU_TOOLS, menuRows, nextMenuIndex } from "./headerPanelControls";
import { __resetForTests, toggleDockPanel } from "../state/layout";
import { DOCK_ORDER } from "./dockModel";
import { blockOf, read as readSource } from "../testkit/source";
import { resetCodeGraphForTest, setCodeGraphStatus } from "../codegraph/codeGraphStore";

beforeEach(() => __resetForTests());

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const noop = (): void => {};

function render(over: Partial<Parameters<typeof HeaderMenu>[0]> = {}): string {
  return renderToStaticMarkup(
    <HeaderMenu
      showDock
      workOffered={false}
      imageCount={0}
      doctorOpen={false}
      onToggleDoctor={noop}
      onOpenKeymap={noop}
      menuOpenForTest
      {...over}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The rows of the open menu, in order, as their data-menu-row ids. */
function rowIds(html: string): string[] {
  return [...html.matchAll(/data-menu-row="([^"]+)"/g)].map((m) => m[1]);
}

describe("the menu holds everything the header used to show", () => {
  it("lists every offered panel, then the tools, in that order; the side panel toggle is outside", () => {
    expect(rowIds(render())).toEqual([...DOCK_ORDER.filter((id) => id !== "work"), ...HEADER_MENU_TOOLS]);
  });

  it("offers the work row only when the v2 reading offers the panel", () => {
    expect(rowIds(render({ workOffered: true }))).toContain("work");
    expect(rowIds(render({ workOffered: false }))).not.toContain("work");
  });

  it("keeps the tools off the chat tab, where the dock does not exist", () => {
    expect(rowIds(render({ showDock: false }))).toEqual([...HEADER_MENU_TOOLS]);
  });

  it("puts the code graph, the keyboard shortcuts and spectro doctor behind a separator", () => {
    // Card 472 added "Build code graph" as the first tool.
    expect([...HEADER_MENU_TOOLS]).toEqual(["codegraph", "keymap", "doctor"]);
    const html = render();
    const sep = html.indexOf('role="separator"');
    expect(sep).toBeGreaterThan(0);
    expect(html.indexOf('data-menu-row="images"')).toBeLessThan(sep);
    expect(html.indexOf('data-menu-row="codegraph"')).toBeGreaterThan(sep);
    expect(html.indexOf('data-menu-row="keymap"')).toBeGreaterThan(sep);
    expect(html.indexOf('data-menu-row="doctor"')).toBeGreaterThan(sep);
  });

  it("draws every row with its icon and its name, so no row is an icon alone", () => {
    const html = render({ workOffered: true });
    const rows = [...html.matchAll(/<button[^>]*data-menu-row="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(rows.length).toBe(rowIds(html).length);
    for (const [, id, body] of rows) {
      expect(body, id).toContain("<svg");
      // The name is the label span's own text, read rather than left over
      // after stripping tags (CodeQL, PR #92: a tag stripper is a sanitizer).
      const label = /class="hdr-menu-label">([^<]+)</.exec(body)?.[1] ?? "";
      expect(label.trim().length, id).toBeGreaterThan(1);
    }
  });

  it("builds the rows from one table, the same one the markup is drawn from", () => {
    expect(menuRows({ showDock: true, workOffered: true }).map((row) => row.id)).toEqual(
      rowIds(render({ workOffered: true })),
    );
  });
});

describe("the checks read the stores, never a copy", () => {
  it("checks the panels the layout store has open", () => {
    toggleDockPanel("plan");
    const html = render();
    // Default layout: agents open; plan opened above.
    expect(html).toMatch(/data-menu-row="agents"[^>]*aria-checked="true"/);
    expect(html).toMatch(/data-menu-row="plan"[^>]*aria-checked="true"/);
    expect(html).toMatch(/data-menu-row="files"[^>]*aria-checked="false"/);
  });

  it("checks doctor from its prop", () => {
    expect(render({ doctorOpen: true })).toMatch(/data-menu-row="doctor"[^>]*aria-checked="true"/);
    // The shortcuts open an overlay; they have no state to check.
    expect(render()).toMatch(/role="menuitem"[^>]*data-menu-row="keymap"/);
  });

  it("carries the image count on the images row", () => {
    expect(render({ imageCount: 3 })).toMatch(/data-menu-row="images"[\s\S]*?hdr-menu-count[^>]*>3</);
  });
});

describe("the keyboard walks the menu", () => {
  it("moves down and up, wraps at both ends and jumps to the ends", () => {
    expect(nextMenuIndex(0, "ArrowDown", 5)).toBe(1);
    expect(nextMenuIndex(4, "ArrowDown", 5)).toBe(0);
    expect(nextMenuIndex(0, "ArrowUp", 5)).toBe(4);
    expect(nextMenuIndex(2, "Home", 5)).toBe(0);
    expect(nextMenuIndex(2, "End", 5)).toBe(4);
    expect(nextMenuIndex(2, "a", 5)).toBe(2);
  });

  it("returns the focus to the ⋮ button when Escape closes the menu", () => {
    const source = read("./headerPanelControls.tsx");
    expect(source).toMatch(/Escape[\s\S]{0,200}\.focus\(\)/);
  });
});

describe("the menu hangs under the header and stays in the window", () => {
  const css = readSource("../styles/header.css", import.meta.url);

  it("opens downward from the right edge of the ⋮ button", () => {
    // A compound selector: `.wsg-pop` is imported later with the same
    // weight, and a single class lost the cascade (the owner's screenshot of
    // 2026-09-29: a 34 px strip that showed only "Work").
    const block = blockOf(css, ".wsg-pop.hdr-menu-pop");
    expect(block).toMatch(/top:\s*calc\(100% \+ 6px\)/);
    expect(block).toMatch(/bottom:\s*auto/);
    expect(block).toMatch(/right:\s*0/);
  });

  it("never grows wider or taller than the window", () => {
    const block = blockOf(css, ".wsg-pop.hdr-menu-pop");
    expect(block).toMatch(/max-width:\s*calc\(100vw - /);
    expect(block).toMatch(/max-height:\s*calc\(100vh - /);
  });
});

describe("the header", () => {
  const header = read("../components/AppHeader.tsx");

  it("mounts the menu exactly once, after the learn and light switch", () => {
    expect(count(header, "<HeaderMenu")).toBe(1);
    expect(header.indexOf("<ModeSwitch")).toBeLessThan(header.indexOf("<HeaderMenu"));
  });

  it("writes through the layout store's own verbs, never a copy", () => {
    const source = read("./headerPanelControls.tsx");
    expect(source).toContain("useLayout()");
    expect(source).toContain("toggleDockPanel(");
    expect(source).toContain("openRightPanel(");
    expect(source).toContain("openDockPanel(");
  });
});

describe("card 472: the code graph row", () => {
  afterEach(() => resetCodeGraphForTest());

  it("is called Build code graph", () => {
    expect(render()).toMatch(/data-menu-row="codegraph"[\s\S]*?hdr-menu-label">Build code graph</);
  });

  it("explains the install line when graphify is not on the PATH", () => {
    setCodeGraphStatus(null, {
      installed: false,
      binary: null,
      searched: ["/usr/bin"],
      install: "uv tool install graphifyy",
      folder: null,
      graph: null,
      job: null,
      backends: [],
    });
    const row = /<button[^>]*data-menu-row="codegraph"[^>]*>([\s\S]*?)<\/button>/.exec(render())?.[1] ?? "";
    expect(row).toContain("hdr-menu-note");
    expect(row).toContain("uv tool install graphifyy");
  });

  it("carries no install note while graphify is installed or not yet known", () => {
    const row = /<button[^>]*data-menu-row="codegraph"[^>]*>([\s\S]*?)<\/button>/.exec(render())?.[1] ?? "";
    expect(row).not.toContain("hdr-menu-note");
  });
});

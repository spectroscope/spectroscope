// Card 228, criterion 7 — the header's panel toggles, the reference shape:
// one icon per panel (files, terminal, browser) with a pressed state, plus an
// overflow menu listing EVERY panel with a check row. The owner asked five
// times; this file is what makes it a criterion instead of a memory.
//
// The load-bearing rule: the icons are the SECOND door to the same
// `spectroscope:layout` truth the dock strip reads — aria-pressed and the
// check rows come from the store, never from a copy. renderToStaticMarkup
// against the real store pins that; the click wiring (static markup drops
// handlers) is read at the source, the dockSeparation idiom.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DockHeaderControls, HEADER_ICON_PANELS } from "./headerPanelControls";
import { __resetForTests, toggleDockPanel } from "../state/layout";
import { DOCK_ORDER } from "./dockModel";
import { dict } from "../i18n/i18n";

beforeEach(() => __resetForTests());

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function render(workOffered = false): string {
  return renderToStaticMarkup(<DockHeaderControls workOffered={workOffered} />);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("one icon per panel, the reference set", () => {
  it("offers exactly files, terminal and browser as header icons", () => {
    expect([...HEADER_ICON_PANELS]).toEqual(["files", "terminal", "browser"]);
    const html = render();
    expect(count(html, "hdr-panel-icon")).toBe(3);
  });

  it("wears the store's truth as its pressed state", () => {
    // Default layout: agents open, the three icon panels closed.
    const closed = render();
    expect(count(closed, 'class="icon-button hdr-panel-icon"')).toBe(3);
    expect(count(closed, "hdr-panel-icon icon-button--on")).toBe(0);
    toggleDockPanel("terminal");
    const open = render();
    // Exactly one icon lights up, and it is the terminal's.
    expect(open).toMatch(/hdr-panel-icon icon-button--on"[^>]*aria-label="Terminal"/);
  });

  it("names each icon by its panel's own label, both languages carried", () => {
    for (const id of HEADER_ICON_PANELS) {
      expect(dict[`rp.${id}`], id).toBeDefined();
      expect(render()).toContain(`aria-label="${dict[`rp.${id}`].en}"`);
    }
  });
});

describe("the overflow menu lists every panel with a check row", () => {
  it("lists all offered panels as menuitemcheckbox rows, checked off the store", () => {
    toggleDockPanel("plan");
    const html = renderToStaticMarkup(<DockHeaderControls workOffered={false} menuOpenForTest />);
    // Six panels without work; agents and plan are the open ones.
    expect(count(html, 'role="menuitemcheckbox"')).toBe(6);
    expect(count(html, 'aria-checked="true"')).toBe(2);
  });

  it("offers the work row only when the v2 reading offers the panel", () => {
    const without = renderToStaticMarkup(<DockHeaderControls workOffered={false} menuOpenForTest />);
    const withWork = renderToStaticMarkup(<DockHeaderControls workOffered menuOpenForTest />);
    expect(count(withWork, 'role="menuitemcheckbox"')).toBe(count(without, 'role="menuitemcheckbox"') + 1);
  });

  it("covers the whole dock vocabulary — a new panel cannot ship without a row", () => {
    const html = renderToStaticMarkup(<DockHeaderControls workOffered menuOpenForTest />);
    for (const id of DOCK_ORDER) {
      expect(html, id).toContain(`data-menu-panel="${id}"`);
    }
  });
});

describe("both doors, one truth", () => {
  const source = read("./headerPanelControls.tsx");
  const header = read("../components/AppHeader.tsx");

  it("writes through the layout store's own verbs, never a copy", () => {
    expect(source).toContain("useLayout()");
    expect(source).toContain("toggleDockPanel(");
    // Opening a panel from the header must also reveal the workspace, or the
    // press changes state nobody can see.
    expect(source).toContain("openRightPanel(");
    expect(source).toContain("openDockPanel(");
  });

  it("is mounted by the header exactly once, beside the workspace toggle", () => {
    expect(count(header, "<DockHeaderControls")).toBe(1);
  });
});

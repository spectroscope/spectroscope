// Card 514 (owner, 2026-10-10): "mach ihn immer da hoch". Back and forward
// stand in the header, immediately left of the mode switch, in every mode and
// on every screen the header is drawn on. The surface bar no longer carries
// them. The suite has no DOM: the header renders on React's server renderer,
// and the click is read off the element the component returns.

import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader } from "./AppHeader";
import { NavSteps } from "./NavSteps";
import { t } from "../i18n/i18n";
import { blankBlockComments, read, stripComments } from "../testkit/source";

function header(over: Partial<Parameters<typeof AppHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    <AppHeader
      sidebarOpen={false}
      onToggleSidebar={() => {}}
      replayId={null}
      title="a session"
      imageCount={0}
      showPanelToggle
      panelOpen={false}
      onTogglePanel={() => {}}
      doctorOpen={false}
      onToggleDoctor={() => {}}
      onOpenKeymap={() => {}}
      canGoBack
      canGoForward
      {...over}
    />,
  );
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

/** The opening tag of the button whose aria-label is the given text. */
function buttonTag(html: string, label: string): string {
  const tag = [...html.matchAll(/<button\b[^>]*>/g)]
    .map((m) => m[0])
    .find((b) => b.includes(`aria-label="${label}"`));
  if (tag === undefined) throw new Error(`no button labelled ${label}`);
  return tag;
}

const BACK = t("en", "nav.back");
const FORWARD = t("en", "nav.forward");

describe("back and forward stand in the header, left of the mode switch (card 514)", () => {
  it("draws the pair immediately before the mode switch, back first", () => {
    const html = header();
    const back = html.indexOf(`aria-label="${BACK}"`);
    const forward = html.indexOf(`aria-label="${FORWARD}"`);
    const modeSwitch = html.indexOf('class="mode-switch" role="radiogroup"');
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(forward);
    expect(forward).toBeLessThan(modeSwitch);
    // Nothing between the forward button and the switch: no other button,
    // no chip, so the pair sits at the same place in every mode.
    const between = html.slice(forward, modeSwitch);
    expect(between.split("<button").length - 1).toBe(0);
    expect(between).not.toMatch(/<(span|div|a)\b[^>]*class="(?!nav-steps)/);
    // Exactly one pair, in the one group that carries it.
    expect(count(html, 'class="nav-steps"')).toBe(1);
    expect(count(html, 'class="nav-steps__step"')).toBe(2);
  });

  it("reaches the pair before the mode switch in the focus order: no tabindex reorders it", () => {
    const html = header();
    expect(buttonTag(html, BACK)).not.toContain("tabindex");
    expect(buttonTag(html, FORWARD)).not.toContain("tabindex");
  });

  it("draws the pair whatever else the header shows: off the chat tab and in a replay", () => {
    for (const html of [header({ showPanelToggle: false }), header({ replayId: "scenario:demo" })]) {
      expect(count(html, 'class="nav-steps__step"')).toBe(2);
      expect(html.indexOf(`aria-label="${FORWARD}"`)).toBeLessThan(html.indexOf('role="radiogroup"'));
    }
  });

  it("darkens back when there is nothing behind, and only back", () => {
    const html = header({ canGoBack: false, canGoForward: true });
    expect(buttonTag(html, BACK)).toContain("disabled");
    expect(buttonTag(html, FORWARD)).not.toContain("disabled");
  });

  it("darkens forward when there is nothing ahead, and only forward", () => {
    const html = header({ canGoBack: true, canGoForward: false });
    expect(buttonTag(html, BACK)).not.toContain("disabled");
    expect(buttonTag(html, FORWARD)).toContain("disabled");
  });

  it("keeps the titles and labels in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const html = renderToStaticMarkup(<NavSteps lang={lang} canBack canForward />);
      for (const key of ["nav.back", "nav.forward"]) {
        const tag = buttonTag(html, t(lang, key));
        expect(tag).toContain(`title="${t(lang, key)}"`);
      }
    }
    expect(t("de", "nav.back")).not.toBe(t("en", "nav.back"));
  });

  it("steps the window's history on a click, as the bar did", () => {
    const back = vi.fn();
    const forward = vi.fn();
    const had = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: { history: { back, forward } },
      configurable: true,
      writable: true,
    });
    try {
      const buttons = elements(NavSteps({ lang: "en", canBack: true, canForward: true })).filter(
        (el) => el.type === "button",
      );
      expect(buttons).toHaveLength(2);
      const byLabel = (label: string) =>
        buttons.find((b) => (b.props as { "aria-label"?: string })["aria-label"] === label);
      (byLabel(BACK)?.props as { onClick: () => void }).onClick();
      expect(back).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
      (byLabel(FORWARD)?.props as { onClick: () => void }).onClick();
      expect(forward).toHaveBeenCalledTimes(1);
    } finally {
      if (had) Object.defineProperty(globalThis, "window", had);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});

/** Every element in a returned tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...elements(children)];
}

describe("the pair has one home (card 514)", () => {
  const app = stripComments(read("../App.tsx", import.meta.url));

  it("is handed the counted depth by App, and the bar draws no pair of its own", () => {
    expect(app).toMatch(/canGoBack=\{canGoBack\(depth\)\}/);
    expect(app).toMatch(/canGoForward=\{canGoForward\(depth\)\}/);
    expect(app).not.toContain("window.history.back()}");
    expect(app).not.toContain("<NavSteps");
  });

  it("draws the header on every screen: nothing about the segment or the mode guards it", () => {
    // The whole surfaces (state graph, skills, Playbook) and an entered fleet
    // swap the bar, never the header; a static render opens on the chat, so
    // the guard reads the source between the column and the header.
    expect(count(app, "<AppHeader")).toBe(1);
    const lead = app.slice(app.indexOf('<div className="main-col">'), app.indexOf("<AppHeader"));
    expect(lead.length).toBeGreaterThan(0);
    for (const condition of [
      "wholeSurface",
      "nav ===",
      "skillsOpen",
      "enteredFleet",
      "isOpen(",
      "viewMode",
    ]) {
      expect(lead, condition).not.toContain(condition);
    }
  });

  it("leaves no style or class behind that names the old place in the bar", () => {
    const css = blankBlockComments(read("../app.css", import.meta.url));
    expect(css).not.toMatch(/tab-nav-(history|step)/);
    expect(app).not.toMatch(/tab-nav-(history|step)/);
    const headerCss = blankBlockComments(read("../styles/header.css", import.meta.url));
    expect(headerCss).toMatch(/\.nav-steps \{/);
    expect(headerCss).toMatch(/\.nav-steps__step:disabled \{/);
  });

  it("tightens the header's gaps on a narrow window, so the pair, the switch and the menu fit at 390 px", () => {
    // Measured live on 2026-10-10 (Playwright, Chrome, 390 px): with the pair
    // added at the 12 px gap the header ran 4 px past the window and clipped the
    // menu. The title already stood at zero, so the gaps give up the width.
    const headerCss = blankBlockComments(read("../styles/header.css", import.meta.url));
    const narrow = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(headerCss);
    expect(narrow).not.toBeNull();
    const rule = /\.header \{([^}]*)\}/.exec(narrow?.[1] ?? "");
    expect(rule?.[1]).toMatch(/gap: var\(--sp-2\);/);
  });

  it("squeezes the header's padding, gaps and the two widest controls below 480 px, so the panel toggle and the menu stay in a 390 px window with a folder chip", () => {
    // Measured live on 2026-10-10 (Playwright, Chrome, 390 px, a session with a
    // folder chip at its floor, learn light developer in the switch): the menu's
    // right edge stood at 457 px and the panel toggle at 389 px, outside the
    // window. The title is at zero and the chip is at the floor card 465 set,
    // so the width comes from the padding, the gaps, the pair and the switch.
    const headerCss = blankBlockComments(read("../styles/header.css", import.meta.url));
    const narrow = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(headerCss);
    expect(narrow).not.toBeNull();
    const block = narrow?.[1] ?? "";
    const body = (selector: string): string =>
      new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(block)?.[1] ?? "";
    expect(body(".header")).toMatch(/padding: 0 var\(--sp-2\);/);
    expect(body(".header")).toMatch(/gap: var\(--sp-1\);/);
    expect(body(".nav-steps__step")).toMatch(/width: 20px;/);
    expect(body(".mode-switch__option")).toMatch(/padding: 3px 3px;/);
    expect(body(".mode-switch__option")).toMatch(/font-size: 10px;/);
    // The chip keeps its name at every width (card 465): nothing here hides it.
    expect(block).not.toMatch(/ws-chip/);
    // Same specificity as the base rules, so the block has to come after them.
    const at = headerCss.indexOf("@media (max-width: 480px)");
    expect(at).toBeGreaterThan(headerCss.indexOf(".nav-steps__step {"));
    expect(at).toBeGreaterThan(headerCss.indexOf(".mode-switch__option {"));
  });

  it("lists back and forward once in the keymap, with the shortcuts unchanged", () => {
    const keymap = read("./Keymap.tsx", import.meta.url);
    expect(count(keymap, 'keys: ["⌘", "←"]')).toBe(1);
    expect(count(keymap, 'keys: ["⌘", "→"]')).toBe(1);
    expect(count(keymap, 'label: { en: "back"')).toBe(1);
    expect(count(keymap, 'label: { en: "forward"')).toBe(1);
    expect(app).toMatch(/e\.key === "ArrowLeft" && canGoBack\(depthRef\.current\)/);
    expect(app).toMatch(/e\.key === "ArrowRight" && canGoForward\(depthRef\.current\)/);
  });
});

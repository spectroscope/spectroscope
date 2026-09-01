// CARD 353 — the browser wears a tab strip, with one tab in it. RED FIRST.
//
// The owner: "dann lass mich wenigstens das aktuelle fenster mit einem x
// zumachen das ich wieder auf die default launch config seite komme" and "baue
// wenigstens die browser tools aus dem screenshot. wenn nicht für mehrere tabs
// dann für einen".
//
// WHAT THIS IS NOT. Not card 347: no second view, no `tabId` on any wire, no
// per-tab draft. `SessionPane.view` stays one field, and the strip is a roster
// of ONE derived from the page that is open — there is no tab state to undo.
// The last test in this file is that guarantee, held rather than promised.
//
// THE "+" IS ABSENT, which is one of the two answers criterion 3 allows. A
// control that looks like it opens a tab and does nothing is worse than no
// control, and the honest half of that pair is cheaper than a disabled button
// with an explanation nobody asked for. The terminal's own strip ships a "+"
// and its rules are copied here WITHOUT it; measured in a real browser, that
// is also what makes this strip 29.00 px against the terminal's 31.80 — the
// "+" is 2.80 px of the terminal's own strip, and this card does not pay it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";
import { blockOf, read, rules } from "../testkit/source";
import {
  DesktopFaceView,
  WebFaceView,
  type DesktopFaceViewProps,
  type WebFaceViewProps,
} from "./BrowserSegment";
import { closePageFrame, tabLabel } from "./liveView";

const PAGE = "https://docs.example.test/guide/one?q=2";

const webProps: WebFaceViewProps = {
  sessionId: "s1",
  mode: "web",
  url: PAGE,
  draft: null,
  picture: { dataUrl: "data:image/jpeg;base64,abc", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
  notice: null,
  launch: null,
  playing: null,
  canGoBack: true,
  canGoForward: true,
  allowLocalhost: false,
  send: () => {},
  onDraft: () => {},
  onPlay: () => {},
};

const desktopProps: DesktopFaceViewProps = {
  state: "attached",
  floored: false,
  sessionId: "s1",
  url: PAGE,
  draft: null,
  notice: null,
  launch: null,
  playing: null,
  canGoBack: true,
  canGoForward: true,
  allowLocalhost: false,
  send: () => {},
  onDraft: () => {},
  onPlay: () => {},
  onShot: () => {},
};

const web = (over: Partial<WebFaceViewProps> = {}): string =>
  renderToStaticMarkup(<WebFaceView {...webProps} {...over} />);
const desktop = (over: Partial<DesktopFaceViewProps> = {}): string =>
  renderToStaticMarkup(<DesktopFaceView {...desktopProps} {...over} />);

/** The strip's markup, or null when the face renders no strip at all. */
function strip(markup: string): string | null {
  const open = markup.indexOf('<div class="browser-tabs"');
  if (open < 0) return null;
  const end = markup.indexOf("</div></div>", open);
  return markup.slice(open, end < 0 ? undefined : end + "</div></div>".length);
}

describe("one tab, showing the open page, with an × (card 353, criterion 1)", () => {
  it("names the page on both faces", () => {
    for (const [face, markup] of [
      ["web", web()],
      ["desktop", desktop()],
    ] as const) {
      const s = strip(markup);
      expect(s, `${face}: no strip while a page is open`).not.toBeNull();
      expect(s as string, `${face}: the tab does not name the page`).toContain("docs.example.test");
    }
  });

  it("carries a close control, and only that one control", () => {
    // Criterion 3, held as a count rather than as a promise: whatever else the
    // strip grows, every control in it has to be one that DOES something, and
    // today there is exactly one.
    for (const markup of [web(), desktop()]) {
      const s = strip(markup) as string;
      expect([...s.matchAll(/<button/g)]).toHaveLength(1);
      expect(s).toContain(t(currentLang(), "browser.tab.close"));
    }
  });

  it("has no + — a control that cannot open a tab is not drawn (criterion 3)", () => {
    for (const markup of [web(), desktop()]) {
      const s = strip(markup) as string;
      expect(s).not.toContain("browser-add");
      expect(s).not.toContain("term-add");
      expect(s).not.toContain(">+<");
    }
  });

  it("closes the page with card 346's verb, carrying no tab identity", () => {
    // Criterion 6: the frame this card sends is the one card 346 already
    // ships. If this card had invented an identity for its one tab, it would
    // show up right here, and card 347 would have to undo it.
    expect(closePageFrame("s1")).toEqual({ type: "close_page", sessionId: "s1" });
    expect(Object.keys(closePageFrame("s1"))).not.toContain("tabId");
  });
});

describe("no tab, no strip (card 353, criterion 2)", () => {
  it("renders nothing while no page is open, on both faces", () => {
    expect(strip(web({ url: null, picture: null }))).toBeNull();
    expect(strip(desktop({ url: null }))).toBeNull();
  });

  it("renders nothing while the face cannot drive the page either", () => {
    // The desktop pane wins; the web face shows no control row in that mode,
    // so a tab with an × the reader cannot press would be chrome for its own
    // sake. Same condition as the control row's, not a second one.
    expect(strip(web({ mode: "desktop" }))).toBeNull();
    expect(strip(desktop({ state: "no-shell" }))).toBeNull();
  });
});

describe("copy through i18n, de and en (card 353, criterion 7)", () => {
  it("speaks the chrome's language, and carries no literal of its own", () => {
    for (const lang of ["de", "en"] as const) {
      setLang(lang);
      try {
        const s = strip(web()) as string;
        expect(s, `${lang}: the strip renders no copy`).toContain(t(lang, "browser.tabs.label"));
        expect(s, `${lang}: the close has no name`).toContain(t(lang, "browser.tab.close"));
        // The two are different sentences: the row's ✕ and the tab's × are two
        // controls, and one accessible name over both is a riddle. The tab's
        // says WHICH page, the row's says what survives.
        expect(t(lang, "browser.tab.close")).not.toBe(t(lang, "browser.view.closePage"));
      } finally {
        setLang("en");
      }
    }
  });

  it("says the same thing in German as in English, not the English", () => {
    // The `map.remote` shape, one card over: a key whose de and en are the
    // same literal is a decision no translator ever sees.
    for (const key of ["browser.tabs.label", "browser.tab.close"] as const) {
      expect(t("de", key), `${key} was never translated`).not.toBe(t("en", key));
    }
  });
});

describe("the label is the page, shortened by a rule and not by a slice", () => {
  it("is the host, which is what a tab in any browser shows", () => {
    expect(tabLabel("https://docs.example.test/guide/one?q=2")).toBe("docs.example.test");
    // The port belongs to the host: two launch configurations on one machine
    // differ by nothing else.
    expect(tabLabel("http://localhost:5173/")).toBe("localhost:5173");
  });

  it("falls back to the address itself when there is no host to take", () => {
    // Never an empty tab: an address the URL parser refuses is still what the
    // record says is open, and half a parse is not a reason to show nothing.
    expect(tabLabel("about:blank")).toBe("about:blank");
    expect(tabLabel("not an address")).toBe("not an address");
  });
});

describe("the strip is the house's, not a new one (card 353, criterion 4)", () => {
  const app = read("../app.css", import.meta.url);
  const term = read("../styles/terminal.css", import.meta.url);
  /** The house rule → this card's copy of it. */
  const PAIRS: [string, string][] = [
    [".term-tabs", ".browser-tabs"],
    [".term-tab", ".browser-tab"],
    [".term-tab--active", ".browser-tab--active"],
    [".term-tab-close", ".browser-tab-close"],
  ];

  /** `prop: value` pairs of one rule, normalised, so order cannot fake a match. */
  const decls = (body: string): string[] =>
    body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter((d) => d !== "")
      .sort();

  it("copies the terminal strip declaration for declaration", () => {
    for (const [house, mine] of PAIRS) {
      expect(decls(blockOf(app, mine)), `${mine} is not ${house}`).toEqual(decls(blockOf(term, house)));
    }
  });

  it("brings no colour and no shadow of its own", () => {
    // The brand's non-negotiables, and the card's own bite: a hex colour or a
    // shadow in this card's CSS goes red.
    //
    // DERIVED, not listed. A hand-written list of this card's four selectors
    // could not see a fifth rule added later — the board's own "two copies of
    // the same lie", and the reason `rules()` exists. Everything the sheet
    // carries whose SUBJECT is one of this strip's elements is in scope,
    // hover states and pseudo-elements included.
    const mine = rules("app.css", app).filter((r) => /^\.browser-tabs?\b|^\.browser-tab-/.test(r.subject));
    expect(mine.length, "the strip's rules are not in app.css at all").toBeGreaterThanOrEqual(5);
    const body = mine.map((r) => r.body).join("\n");
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
    expect(body).not.toMatch(/box-shadow|text-shadow|filter:\s*drop-shadow/i);
  });

  it("keeps the label a label — the terminal's pick is a control and this one is not", () => {
    // `.term-tab-pick` is a BUTTON because clicking it selects that tab. With a
    // roster of one there is nothing to select, so this is a span, and its
    // rule is the terminal's minus the four button resets plus the line-height
    // a button gets for free. Measured in a real browser: without the
    // line-height the span stands 21.05 px against the button's 18.00 and the
    // whole strip grows from 29.00 to 32.05.
    const mine = decls(blockOf(app, ".browser-tab-pick"));
    const house = decls(blockOf(term, ".term-tab-pick"));
    const buttonResets = ["border: none", "background: none", "cursor: pointer", "color: var(--text-dim)"];
    expect(mine).toEqual([...house.filter((d) => !buttonResets.includes(d)), "line-height: normal"].sort());
  });
});

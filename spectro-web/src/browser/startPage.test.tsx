// The start page and the desktop face's control row (card 227).
//
// Same method as webFaceView.test.tsx: no DOM, react-dom/server renders the
// presentational halves and the assertions read the markup. The socket glue
// stays in BrowserSegment and is not started here.
//
// What is load-bearing and why:
// - criterion 2, the face half: the browser's empty state IS the start page —
//   one row per configuration with its address and a play button; with no
//   configs, one terse line says how to add one. On BOTH faces.
// - criterion 1, the desktop half: the desktop face carries the same control
//   row the web face has (URL field, back/forward, reload, screenshot), so the
//   two faces read identically.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopFaceView,
  StartPage,
  WebFaceView,
  type DesktopFaceViewProps,
  type WebFaceViewProps,
} from "./BrowserSegment";
import type { LaunchList } from "./liveView";
import { t } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";

const en = currentLang();

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const twoConfigs: LaunchList = {
  ok: true,
  sentence: null,
  skipped: 0,
  location: ".claude/launch.json",
  shadowed: [],
  configs: [
    { name: "web", address: "http://localhost:5173/", attaches: false, up: true, exitCode: null },
    { name: "api", address: "http://localhost:9999/", attaches: true, up: false, exitCode: 137 },
  ],
};

const noConfigs: LaunchList = {
  ok: true,
  sentence: null,
  skipped: 0,
  location: null,
  shadowed: [],
  configs: [],
};

function start(launch: LaunchList | null, playing: string | null = null): string {
  return renderToStaticMarkup(<StartPage launch={launch} playing={playing} onPlay={() => {}} />);
}

function webView(overrides: Partial<WebFaceViewProps>): string {
  const props: WebFaceViewProps = {
    sessionId: "s1",
    mode: "web",
    url: null,
    draft: null,
    picture: null,
    notice: null,
    launch: null,
    playing: null,
    canGoBack: null,
    canGoForward: null,
    send: () => {},
    onDraft: () => {},
    onPlay: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<WebFaceView {...props} />);
}

function desktopView(overrides: Partial<DesktopFaceViewProps>): string {
  const props: DesktopFaceViewProps = {
    state: "attached",
    floored: false,
    sessionId: "s1",
    url: null,
    draft: null,
    notice: null,
    launch: null,
    playing: null,
    canGoBack: null,
    canGoForward: null,
    send: () => {},
    onDraft: () => {},
    onPlay: () => {},
    onShot: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<DesktopFaceView {...props} />);
}

describe("the start page lists the session's configurations — criterion 2", () => {
  const markup = start(twoConfigs);

  it("carries one row per configuration, named, with its address", () => {
    expect(markup).toContain("web");
    expect(markup).toContain("http://localhost:5173/");
    expect(markup).toContain("api");
    expect(markup).toContain("http://localhost:9999/");
  });

  it("gives every row a play button that names its configuration", () => {
    expect(markup).toContain(esc(t(en, "browser.start.play", { name: "web" })));
    expect(markup).toContain(esc(t(en, "browser.start.play", { name: "api" })));
  });

  it("says which configuration is up and which run ended, with its code", () => {
    expect(markup).toContain(esc(t(en, "browser.start.running")));
    expect(markup).toContain(esc(t(en, "browser.start.exited", { code: 137 })));
  });

  it("marks the entry that only attaches — play spawns nothing for it", () => {
    expect(markup).toContain(esc(t(en, "browser.start.attach")));
  });

  it("disables play while one configuration is already starting", () => {
    const busy = start(twoConfigs, "web");
    expect(busy.match(/disabled/g)?.length).toBe(2);
    expect(start(twoConfigs).match(/disabled/g) ?? []).toHaveLength(0);
  });
});

describe("the start page with nothing to list — criterion 2's other half", () => {
  it("says how to add a configuration, tersely, when the file has none", () => {
    expect(start(noConfigs)).toContain(esc(t(en, "browser.start.none")));
  });

  it("shows the server's own sentence when the list was refused", () => {
    const markup = start({
      ok: false,
      sentence: "this session is not open on this server",
      skipped: 0,
      location: null,
      shadowed: [],
      configs: [],
    });
    expect(markup).toContain("this session is not open on this server");
    expect(markup).not.toContain(esc(t(en, "browser.start.none")));
  });

  it("counts the entries the reader had to skip", () => {
    const markup = start({ ...twoConfigs, skipped: 2 });
    expect(markup).toContain(esc(t(en, "browser.start.skipped", { n: 2 })));
    expect(start(twoConfigs)).not.toContain(esc(t(en, "browser.start.skipped", { n: 0 })));
  });

  it("says it in German too", () => {
    setLang("de");
    try {
      expect(start(noConfigs)).toContain(esc(t("de", "browser.start.none")));
      expect(start(twoConfigs)).toContain(esc(t("de", "browser.start.play", { name: "web" })));
    } finally {
      setLang(en);
    }
  });
});

describe("the web face's empty state IS the start page", () => {
  it("renders the start page where the idle note used to stand", () => {
    const markup = webView({ mode: "web", url: null, launch: twoConfigs });
    expect(markup).toContain(esc(t(en, "browser.start.heading")));
    expect(markup).toContain(esc(t(en, "browser.start.play", { name: "web" })));
  });

  it("keeps the idle note for a page that is open but not yet cast", () => {
    // A URL is open — the picture is on its way. A start page here would
    // read as "nothing is running" over a page that is.
    const markup = webView({ mode: "web", url: "https://example.test/", launch: twoConfigs });
    expect(markup).toContain(esc(t(en, "browser.view.idleNote")));
    expect(markup).not.toContain(esc(t(en, "browser.start.heading")));
  });
});

describe("the desktop face gains the control row — criterion 1", () => {
  const markup = desktopView({ url: "http://localhost:5173/" });

  it("has back, forward, reload, the URL field and the screenshot control", () => {
    for (const key of [
      "browser.view.back",
      "browser.view.forward",
      "browser.view.reload",
      "browser.view.address",
      "browser.view.screenshot",
    ]) {
      expect(markup, key).toContain(`aria-label="${esc(t(en, key))}"`);
    }
  });

  it("carries the page's address in the field, like the web face", () => {
    expect(markup).toContain('value="http://localhost:5173/"');
  });

  it("shows the start page in the hole while no page is open", () => {
    const idle = desktopView({ url: null, launch: twoConfigs });
    expect(idle).toContain(esc(t(en, "browser.start.heading")));
    expect(idle).toContain(esc(t(en, "browser.start.play", { name: "web" })));
  });

  it("keeps the hole clear of the start page once a page is open", () => {
    expect(desktopView({ url: "http://localhost:5173/", launch: twoConfigs })).not.toContain(
      esc(t(en, "browser.start.heading")),
    );
  });

  it("shows a refusal where the address was typed, as an alert", () => {
    const markup = desktopView({ notice: "an agent browser call is in flight for this session" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("an agent browser call is in flight for this session");
  });

  it("keeps the honest notes when no pane is attached — no controls to mislead", () => {
    const markup = desktopView({ state: "no-shell" });
    expect(markup).toContain(esc(t(en, "browser.noShellNote")));
    expect(markup).not.toContain(`aria-label="${esc(t(en, "browser.view.back"))}"`);
  });
});

// The browser toolbar says what it knows (card 344) and the page can be closed
// (card 346).
//
// Same method as webFaceView.test.tsx and startPage.test.tsx: no DOM, the two
// faces are functions of their props, react-dom/server renders them and the
// assertions read the markup.
//
// What is load-bearing and why, one describe per criterion:
// - 344 (a): the web face's row does not VANISH while the desktop pane drives.
//   It said nothing at all, and the owner runs the desktop app, so the row he
//   sees in the web window is the one that was never there.
// - 344 (b): the reload control asks for a reload, not for a re-navigate to the
//   remembered address. The mechanism that keeps form state is pinned where the
//   engines are (HeadlessBrowserFaceTest, sessionPanes.test.ts); what is pinned
//   here is that the button no longer builds a navigate frame.
// - 344 (c): back and forward are disabled only where the server SAID there is
//   nothing there. An unknown answer leaves the button alone, deliberately —
//   see the note on ViewState.canGoBack.
// - 346: the close control stands beside the others, and it is dead while no
//   page is open, like the screenshot control beside it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopFaceView,
  WebFaceView,
  type DesktopFaceViewProps,
  type WebFaceViewProps,
} from "./BrowserSegment";
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
    // Card 355: the ship default, and the state the footer note used to
    // describe unconditionally. These suites are about other things.
    allowLocalhost: false,
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
    // Card 355: the ship default, and the state the footer note used to
    // describe unconditionally. These suites are about other things.
    allowLocalhost: false,
    send: () => {},
    onDraft: () => {},
    onPlay: () => {},
    onShot: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<DesktopFaceView {...props} />);
}

/** The one button carrying this label, from `<button` to its `>`. */
function buttonWith(markup: string, label: string): string {
  const at = markup.indexOf(`aria-label="${esc(t(en, label))}"`);
  expect(at, `no control carries ${label}`).toBeGreaterThan(-1);
  const opens = markup.lastIndexOf("<button", at);
  return markup.slice(opens, markup.indexOf(">", at) + 1);
}

describe("344 (a): the row says who is driving instead of vanishing", () => {
  const markup = webView({ mode: "desktop", url: "https://example.test/" });

  it("says in the row that the desktop face is driving", () => {
    expect(markup.slice(0, markup.indexOf("</header>"))).toContain(esc(t(en, "browser.view.rowDesktopNote")));
  });

  it("still offers no controls that would race the pane", () => {
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain(`aria-label="${esc(t(en, "browser.view.back"))}"`);
  });

  it("keeps the address readable where the controls would have been", () => {
    expect(markup).toContain("https://example.test/");
  });

  it("says it in German too", () => {
    setLang("de");
    try {
      expect(webView({ mode: "desktop", url: null })).toContain(esc(t("de", "browser.view.rowDesktopNote")));
    } finally {
      setLang(en);
    }
  });

  it("says nothing of the sort where the web face IS driving", () => {
    expect(webView({ mode: "web", url: "https://example.test/" })).not.toContain(
      esc(t(en, "browser.view.rowDesktopNote")),
    );
  });
});

describe("344 (b): the reload control asks for a reload", () => {
  // The mechanism — Chromium's own reload rather than a fresh load of the
  // remembered address — is pinned on both engines. What can go wrong HERE is
  // the button building the wrong frame again, which is what it did: the shell
  // refuses a re-navigate in writing for back/forward one file away, and the
  // reload button did exactly that.
  const source = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
  const at = source.indexOf('"browser.view.reload"');
  const button = source.slice(source.lastIndexOf("<button", at), source.indexOf("</button>", at));

  it("builds a reload frame", () => {
    expect(button).toContain("reloadFrame(");
  });

  it("does not re-navigate to the remembered address", () => {
    expect(button).not.toContain("navigateFrame(");
  });
});

describe("344 (c): back and forward are dead when there is nothing there", () => {
  it("disables back when the server said there is nothing earlier", () => {
    const markup = webView({ url: "https://example.test/", canGoBack: false, canGoForward: true });
    expect(buttonWith(markup, "browser.view.back")).toContain("disabled");
    expect(buttonWith(markup, "browser.view.forward")).not.toContain("disabled");
  });

  it("disables forward when the server said there is nothing later", () => {
    const markup = webView({ url: "https://example.test/", canGoBack: true, canGoForward: false });
    expect(buttonWith(markup, "browser.view.forward")).toContain("disabled");
    expect(buttonWith(markup, "browser.view.back")).not.toContain("disabled");
  });

  it("leaves BOTH alone where the face did not say — an unknown never disables", () => {
    // The honest floor. The desktop face's shell pushes no navigation, so its
    // answer is unknown and its buttons keep today's behaviour: press it and
    // read the sentence. A disabled button there would be a guess.
    const markup = desktopView({ url: "https://example.test/" });
    expect(buttonWith(markup, "browser.view.back")).not.toContain("disabled");
    expect(buttonWith(markup, "browser.view.forward")).not.toContain("disabled");
  });

  it("carries the same two answers to the desktop face when they arrive", () => {
    const markup = desktopView({
      url: "https://example.test/",
      canGoBack: false,
      canGoForward: false,
    });
    expect(buttonWith(markup, "browser.view.back")).toContain("disabled");
    expect(buttonWith(markup, "browser.view.forward")).toContain("disabled");
  });
});

describe("346: the page can be closed, on both faces", () => {
  it("stands a close control in the web face's row", () => {
    const markup = webView({ url: "https://example.test/" });
    expect(markup).toContain(`aria-label="${esc(t(en, "browser.view.closePage"))}"`);
  });

  it("stands the same control in the desktop face's row", () => {
    const markup = desktopView({ url: "https://example.test/" });
    expect(markup).toContain(`aria-label="${esc(t(en, "browser.view.closePage"))}"`);
  });

  it("is dead while no page is open — there is nothing to close", () => {
    expect(buttonWith(webView({ url: null }), "browser.view.closePage")).toContain("disabled");
    expect(buttonWith(desktopView({ url: null }), "browser.view.closePage")).toContain("disabled");
  });

  it("is alive once a page is open", () => {
    expect(buttonWith(webView({ url: "https://example.test/" }), "browser.view.closePage")).not.toContain(
      "disabled",
    );
    expect(buttonWith(desktopView({ url: "https://example.test/" }), "browser.view.closePage")).not.toContain(
      "disabled",
    );
  });

  it("says it in German too", () => {
    setLang("de");
    try {
      expect(webView({ url: "https://example.test/" })).toContain(esc(t("de", "browser.view.closePage")));
    } finally {
      setLang(en);
    }
  });
});

describe("346 (5): a closed page is gone from the hole, and cannot be driven", () => {
  // THE HAZARD, and it is the reason this describe exists rather than one
  // assertion inside the block above. Two independent things kept the closed
  // page on screen and live under the reader's mouse:
  //
  //   the socket held the frame — a close leaves `live === "web"`, and the
  //   only thing that dropped a held picture was a face flip;
  //   the face RENDERED it — `live && picture !== null` asks nothing about
  //   whether a page is open, and the img it builds carries onClick, onWheel
  //   and onKeyDown, so a click on a page that is gone still went out as an
  //   `input` verb naming a coordinate on it.
  //
  // The first is pinned in liveView.test.ts (heldPictureSurvives), the second
  // here, and each fails on its own: neither is the other's second copy.
  const closed = {
    mode: "web" as const,
    url: null,
    picture: { dataUrl: "data:image/jpeg;base64,abc", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
  };

  it("shows no live picture where no page is open, even holding one", () => {
    expect(webView(closed)).not.toContain("view-live");
  });

  it("stands the start page there instead — the other half of what he asked for", () => {
    expect(webView(closed)).toContain("browser-start");
  });

  it("leaves nothing focusable in the hole to drive", () => {
    // The img was `tabIndex={0}` with three handlers on it. A frame that is
    // not rendered cannot be clicked, and this is the assertion that says so
    // in the markup rather than in a comment.
    const hole = webView(closed);
    expect(hole.slice(hole.indexOf("browser-hole"))).not.toContain('tabindex="0"');
  });

  it("still shows the picture while a page IS open", () => {
    expect(webView({ ...closed, url: "https://example.test/" })).toContain("view-live");
  });

  // THE THIRD THING, and neither pin above can see it: the WIRING.
  // heldPictureSurvives is a pure function and liveView.test.ts proves what it
  // answers; the component still has to ASK it. Put the old face comparison
  // back in the socket's state arm and both other pins stay green — the
  // function answers correctly, the face renders correctly, and the closed
  // page is held on screen again.
  //
  // WHAT THIS READS IS THE SOURCE, not the behaviour. The effect that owns the
  // call runs only in a mounted component and these tests render to a string,
  // so this is a pin on the call site's shape and reaches no further than that.
  it("asks heldPictureSurvives in the socket's state arm, not the face a second time", () => {
    const source = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
    const arm = source.slice(source.indexOf('case "state":'), source.indexOf('case "frame":'));
    expect(arm).toMatch(/if\s*\(\s*!heldPictureSurvives\(msg\.state\)\s*\)\s*setPicture\(null\)/);
    expect(arm, "a face comparison here is the defect, not the guard").not.toMatch(/\.live\s*[!=]==/);
  });
});

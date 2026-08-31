// The web face's browser view, rendered and read (card 226).
//
// No DOM in this suite, the house way: the view is a function of its props, so
// react-dom/server renders each mode and the assertions read the markup. The
// socket glue stays in BrowserSegment and is not started here — static markup
// runs no effects, which is exactly the isolation this suite wants.
//
// What is load-bearing and why:
// - criterion 1: the streamed picture, the URL bar, back/forward, a screenshot
//   control — all present in the web mode and ONLY there.
// - criterion 5: the segment says WHICH face is live, in words, in every
//   settled mode.
// - criterion 7: the old stub text survives only in the none mode, where no
//   real thing stands.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WebFaceView, type WebFaceViewProps } from "./BrowserSegment";
import { fenceNote } from "./fenceNote";
import { t } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";

const en = currentLang();

/** What renderToStaticMarkup makes of a sentence — apostrophes and quotes
 *  leave as entities, so the assertions must expect the markup's own spelling. */
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function view(overrides: Partial<WebFaceViewProps>): string {
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

describe("the web mode carries the whole surface — criterion 1", () => {
  const markup = view({
    mode: "web",
    url: "https://example.test/",
    picture: { dataUrl: "data:image/jpeg;base64,abc", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
  });

  it("draws the streamed picture", () => {
    expect(markup).toContain('src="data:image/jpeg;base64,abc"');
  });

  it("has the URL bar as an input carrying the page's address", () => {
    expect(markup).toContain('value="https://example.test/"');
    expect(markup).toContain(`aria-label="${esc(t(en, "browser.view.address"))}"`);
  });

  it("has back, forward, reload and the screenshot control", () => {
    for (const key of [
      "browser.view.back",
      "browser.view.forward",
      "browser.view.reload",
      "browser.view.screenshot",
    ]) {
      expect(markup, key).toContain(`aria-label="${esc(t(en, key))}"`);
    }
  });

  it("says the server face is the live one — criterion 5", () => {
    expect(markup).toContain(esc(t(en, "browser.view.faceWeb")));
  });

  it("keeps the picture reachable by keyboard, and says what keys do", () => {
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(`alt="${esc(t(en, "browser.view.pictureLabel"))}"`);
  });
});

describe("what the reader typed wins over what the page says", () => {
  it("shows the draft while one is being typed", () => {
    const markup = view({ mode: "web", url: "https://example.test/", draft: "spectroscope" });
    expect(markup).toContain('value="spectroscope"');
    expect(markup).not.toContain('value="https://example.test/"');
  });
});

describe("the web mode before any page", () => {
  // Replaced under card 227: the idle sentence gave way to the START PAGE —
  // the empty browser now lists the session's launch configurations. The
  // start page's own behaviour is pinned in startPage.test.tsx; this suite
  // keeps only the mode boundary: no picture, and the start page stands.
  const markup = view({ mode: "web", url: null, picture: null });

  it("shows no picture and stands the start page where the idle note stood", () => {
    expect(markup).not.toContain("<img");
    expect(markup).toContain(esc(t(en, "browser.start.heading")));
  });
});

describe("the desktop mode drives nothing and says whose the browser is", () => {
  const markup = view({ mode: "desktop", url: "https://example.test/" });

  it("names the desktop pane as the live face — criterion 5", () => {
    expect(markup).toContain(esc(t(en, "browser.view.faceDesktop")));
    expect(markup).toContain(esc(t(en, "browser.view.desktopLiveNote")));
  });

  it("offers no controls that would race the pane", () => {
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain(`aria-label="${esc(t(en, "browser.view.back"))}"`);
  });

  it("says it in German too", () => {
    setLang("de");
    try {
      expect(view({ mode: "desktop", url: null })).toContain(esc(t("de", "browser.view.desktopLiveNote")));
    } finally {
      setLang(en);
    }
  });
});

describe("the none mode keeps the old honest stub — criterion 7", () => {
  const markup = view({ mode: "none", url: null });

  it("keeps the stub sentences where no real thing stands", () => {
    expect(markup).toContain(esc(t(en, "browser.noShellNote")));
    expect(markup).toContain(esc(t(en, "browser.noShellHint")));
  });

  it("still names the face: none", () => {
    expect(markup).toContain(esc(t(en, "browser.view.faceNone")));
  });
});

describe("before the first state frame", () => {
  it("says it is connecting rather than guessing a face", () => {
    const markup = view({ mode: "connecting" });
    expect(markup).toContain(esc(t(en, "browser.loadingNote")));
    expect(markup).not.toContain(esc(t(en, "browser.view.faceWeb")));
  });
});

describe("a refusal is shown where the address was typed", () => {
  it("renders the fence's sentence as an alert", () => {
    const markup = view({ mode: "web", notice: "refused: the net fence keeps private ranges off limits" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("refused: the net fence keeps private ranges off limits");
  });
});

describe("the fence note stays on every mode", () => {
  it("is present in web and none alike", () => {
    // Card 355 turned the note from one frozen string into a composition over
    // the process's own fence state; it still stands under every mode, because
    // whether it should stop being permanent is the owner's call.
    expect(view({ mode: "web" })).toContain(esc(fenceNote(en, false)));
    expect(view({ mode: "none" })).toContain(esc(fenceNote(en, false)));
  });

  it("follows the fence rather than reciting it", () => {
    expect(view({ mode: "web", allowLocalhost: true })).toContain(esc(fenceNote(en, true)));
    expect(view({ mode: "web", allowLocalhost: true })).not.toContain(
      esc(t(en, "browser.fence.loopbackOff")),
    );
  });
});

// Card 355 criterion 4. The footer doubles as the explanation when the fence
// refuses something, so trimming the footer must not cost a refusal its words.
// It does not, and the reason is structural rather than lucky: the refusal is
// composed by NetFence and arrives as its own frame's sentence, while the
// footer is composed here. This pins that the two do not share a source — with
// the opt-in ON, and the footer therefore silent about the opt-in, the refusal
// still names the rule AND the setting that would lift it.
describe("a refusal keeps its own words when the footer sheds a clause", () => {
  // NetFence#refusalFor, verbatim: "refused <what>: <why> (rule: <name>)."
  const refusal =
    "refused http://localhost:8746/: it is this machine, and the local verify loop is not opted in " +
    "(set allowLocalhost in the settings to reach it on purpose) (rule: loopback).";

  it("names the rule and the opt-in, with the footer no longer mentioning either", () => {
    const markup = view({ mode: "web", allowLocalhost: true, notice: refusal });
    expect(markup).toContain('role="alert"');
    expect(markup, "the refusal lost words on the way to the screen").toContain(esc(refusal));
    expect(markup).toContain("rule: loopback");
    expect(esc(fenceNote(en, true)), "the footer is the wrong source for this").not.toContain("rule:");
  });
});

describe("Enter commits the address explicitly", () => {
  // Found live on 2026-08-14, on this build's own jar: the address form relied
  // on the browser's IMPLICIT submission (one input, no submit button), and a
  // CDP-injected Return — the way this product's own pane drives keys — never
  // fired it. requestSubmit() navigated fine, so delivery was the broken half.
  // The input therefore commits Enter itself, and this test pins that the
  // handler exists rather than hoping the next refactor keeps the accident.
  it("handles Enter on the input instead of trusting implicit submission", () => {
    const source = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
    const input = source.slice(source.indexOf("view-address-input"));
    expect(input.slice(0, 800)).toMatch(/onKeyDown/);
    expect(input.slice(0, 800)).toMatch(/"Enter"/);
  });
});

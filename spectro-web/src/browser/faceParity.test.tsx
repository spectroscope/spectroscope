// The two faces carry the SAME control row — compared, not typed twice.
//
// Card 227 criterion 1 says the desktop face and the web face read identically,
// and it was pinned by two hand-written lists of the same five i18n keys, one in
// webFaceView.test.tsx and one in startPage.test.tsx. Neither list could go red
// for a control that exists on one face and not the other: a sixth button added
// to one file turns both suites green, because both suites only ever asked
// "are my five still there".
//
// The canon's "two copies of the same lie", third time on this board after
// cards 312 and 334. The cure is the same one: derive instead of type. This
// file renders BOTH faces with equivalent props and compares the sets of
// control labels their rows carry. A control on one face and not the other is
// red here and nowhere else.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import {
  DesktopFaceView,
  WebFaceView,
  type DesktopFaceViewProps,
  type WebFaceViewProps,
} from "./BrowserSegment";

/** Equivalent states: one page open, both faces live and driving it. */
const URL = "https://example.test/";

const webProps: WebFaceViewProps = {
  sessionId: "s1",
  mode: "web",
  url: URL,
  draft: null,
  // The web face's screenshot control is dead without a picture and the
  // desktop face's is dead without a url — two mechanisms, card 344's own
  // finding. A picture here puts both faces in their driving state, which is
  // the state the comparison is about.
  picture: { dataUrl: "data:image/jpeg;base64,abc", deviceWidth: 1280, deviceHeight: 800, ts: 1 },
  notice: null,
  launch: null,
  playing: null,
  canGoBack: true,
  canGoForward: true,
  send: () => {},
  onDraft: () => {},
  onPlay: () => {},
};

const desktopProps: DesktopFaceViewProps = {
  state: "attached",
  floored: false,
  sessionId: "s1",
  url: URL,
  draft: null,
  notice: null,
  launch: null,
  playing: null,
  canGoBack: true,
  canGoForward: true,
  send: () => {},
  onDraft: () => {},
  onPlay: () => {},
  onShot: () => {},
};

/**
 * Every control label the row carries, derived from the rendered markup.
 *
 * The row and not the whole surface: the empty states, the picture and the
 * start page differ between the faces on purpose, and a comparison that swept
 * them in would be red for the design rather than for a missing control.
 */
function rowControls(markup: string): string[] {
  const opens = markup.indexOf("<header");
  const closes = markup.indexOf("</header>");
  expect(opens, "the face renders no control row at all").toBeGreaterThan(-1);
  const row = markup.slice(opens, closes);
  return [...row.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).sort();
}

/**
 * The control labels the SHARED row declares, read from NavControls' own
 * source.
 *
 * <p>Not a list typed here: this file exists because two hand-typed lists
 * could not go red, and a third one in the guard against them would be the
 * same mistake wearing the cure's name. The source is the one place a control
 * is added, so it is the one place the expectation comes from.
 */
const sharedRowLabels: string[] = (() => {
  const source = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
  const start = source.indexOf("function NavControls(");
  expect(start, "NavControls moved or was renamed").toBeGreaterThan(-1);
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  const lang = currentLang();
  return [...body.matchAll(/aria-label=\{t\(lang, "([^"]+)"/g)].map((m) => t(lang, m[1])).sort();
})();

describe("the two faces carry the same control row — compared, not listed", () => {
  const web = rowControls(renderToStaticMarkup(<WebFaceView {...webProps} />));
  const desktop = rowControls(renderToStaticMarkup(<DesktopFaceView {...desktopProps} />));

  it("names the same controls, whichever face is live", () => {
    expect(web).toEqual(desktop);
  });

  it("carries every control the shared row declares, so an equal pair of nothings cannot pass", () => {
    // Two faces that both rendered NO controls would satisfy the test above,
    // which is why this one stands beside it. A hand-typed floor stood here,
    // `web.length >= 5`, beside a comment naming seven controls — and the gap
    // was real slack, measured: the web row renders SEVEN labels, and with the
    // close control stopped from rendering on both faces it renders six, which
    // the old floor called fine. Two equal rows, one control quietly gone.
    //
    // Derived instead. NavControls is the row BOTH faces mount, so what it
    // declares is the floor, read out of its own source rather than typed
    // again here. Bitten in that exact direction: hiding one of its buttons
    // leaves the comparison above green and turns this red.
    //
    // WHAT IT DOES NOT CATCH, said rather than implied: deleting a control
    // from NavControls outright shrinks the expectation with the render, and
    // both stay green. That case belongs to a reader of the card, not to a
    // derivation from the same file — and toolbarTruth.test.tsx names each
    // control it wants by hand, on purpose, one layer down.
    expect(sharedRowLabels.length, "NavControls declares no labels — the parse missed").toBeGreaterThan(0);
    expect(web).toEqual(expect.arrayContaining(sharedRowLabels));
    expect(desktop).toEqual(expect.arrayContaining(sharedRowLabels));
  });
});

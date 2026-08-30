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

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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

describe("the two faces carry the same control row — compared, not listed", () => {
  const web = rowControls(renderToStaticMarkup(<WebFaceView {...webProps} />));
  const desktop = rowControls(renderToStaticMarkup(<DesktopFaceView {...desktopProps} />));

  it("names the same controls, whichever face is live", () => {
    expect(web).toEqual(desktop);
  });

  it("compares a row that is not empty, so an equal pair of nothings cannot pass", () => {
    // Two faces that both rendered no controls would satisfy the test above.
    // The row is known to carry back, forward, reload, the address, the
    // screenshot, the launch menu and the close — this asserts there ARE
    // controls without re-typing which, which is the trap this file exists for.
    expect(web.length).toBeGreaterThanOrEqual(5);
  });
});

// The port survives a narrow panel.
//
// The owner pressed play on a launch configuration and reported "ich sehe nicht
// den port": the row shows `http://localhost:80…` and the number he needs is
// inside the ellipsis. Card 227's own criterion 2 asked for "the session's
// launch configurations listed with their ports", so this is a criterion that
// shipped satisfied in the markup and unsatisfied on the screen.
//
// WHY THE PORT SPECIFICALLY, and not just "text is truncated". The address is
// the ONLY flex-shrinkable item in the row — the play button, the name and the
// chips are all `flex: 0 0 auto` — so it absorbs every pixel of shortfall. And
// `text-overflow: ellipsis` clips the TAIL. The port is the tail. So the seven
// characters that carry no information (`http://`) are the ones guaranteed to
// survive, and the four that are the whole point are the first to go. Widening
// the panel is not an answer either: the row lives inside `.browser-start`,
// which is `width: min(52ch, 100%)`, so there is a hard ceiling no window size
// can lift.
//
// The two halves below are deliberately different KINDS of check, because a
// tooltip and a visible port answer different questions and neither implies the
// other. A test that only asserted the markup contains the address would pass
// today, on the broken build — the address IS in the DOM, which is exactly why
// nothing went red.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartPage } from "./BrowserSegment";
import type { LaunchList } from "./liveView";

const list = (address: string | null): LaunchList => ({
  ok: true,
  sentence: null,
  skipped: 0,
  configs: [{ name: "particle-editor", address, attaches: false, up: false, exitCode: null }],
});

const render = (address: string | null): string =>
  renderToStaticMarkup(<StartPage launch={list(address)} playing={null} onPlay={() => {}} />);

describe("the launch row keeps its port readable", () => {
  it("splits the address so the shrinking half is the part nobody needs", () => {
    // The RESULT, not the remedy: whatever the markup does, the port must sit
    // in an element the flex shortfall cannot shrink. Asserting "there is a
    // span called browser-start-port" would pass on a span that still lives
    // inside the shrinking box, so the class is checked AND its position
    // relative to the shrinking one.
    const html = render("http://localhost:8080/");
    const head = html.indexOf('class="browser-start-address"');
    const port = html.indexOf('class="browser-start-port"');
    expect(head).toBeGreaterThan(-1);
    expect(port).toBeGreaterThan(head);
    // The port element carries the port and the head does not, so a clip of the
    // head cannot take it.
    expect(html).toContain(">:8080/<");
    // The VISIBLE text of the head, not the slice — the first draft of this
    // assertion read the whole slice and failed on the `title` attribute, which
    // carries the port ON PURPOSE. Attributes are not clipped by an ellipsis;
    // only the text node is, and the text node is what this is about.
    const headText = html.slice(html.indexOf(">", head) + 1, html.indexOf("</span>", head));
    expect(headText).toBe("http://localhost");
    expect(headText).not.toContain("8080");
  });

  it("carries the whole address in a tooltip, the way the address bar already does", () => {
    // The same idiom two elements away in this file (BrowserSegment.tsx:531,
    // :815) — a `title` on the ellipsised span. Cheap, and it is the only thing
    // that helps when the name is long enough to eat the head as well.
    expect(render("http://localhost:8080/")).toContain('title="http://localhost:8080/"');
  });

  it("does not invent a port where the address has none", () => {
    // A launch entry may carry no address at all (the row renders an em dash),
    // and a host with no port must not grow a stray colon. Both directions,
    // because a splitter that always emits a tail is the obvious wrong shape.
    const none = render(null);
    expect(none).toContain("—");
    expect(none).not.toContain('class="browser-start-port"');

    const noPort = render("https://example.com/thing");
    expect(noPort).not.toContain('class="browser-start-port"');
    expect(noPort).toContain("https://example.com/thing");
  });

  it("keeps the port with the trailing path, since the ellipsis would eat that too", () => {
    // `http://localhost:8080/app` clips to `http://localhost:80…` today. The
    // tail is everything from the colon on, not just the digits, or the reader
    // gets a port and loses the path in the same breath.
    const html = render("http://localhost:8080/app");
    const port = html.indexOf('class="browser-start-port"');
    expect(port).toBeGreaterThan(-1);
    expect(html.slice(port)).toContain(":8080/app");
  });
});

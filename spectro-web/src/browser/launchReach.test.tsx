// The launch configurations are reachable while a page is open (card 345).
//
// THE DEFECT. `StartPage` is the only place in the whole product that lists a
// session's launch configurations — `grep -rn "StartPage" src` minus tests
// returns exactly three lines: its definition and its two mounts. Both mounts
// sit behind `live && url === null` (BrowserSegment.tsx:564-568), and `url`
// never becomes null again once a page has loaded. So the list is reachable
// exactly once per session, before anything opens a page, and never after.
//
// The owner: "so kann ich … nie auf das default bild mit den launch konfigs
// kommen. für diese bitte ein dropdown neben den tabs machen".
//
// WHAT MAKES THIS THREE FILES RATHER THAN A FEATURE. The list is built, the
// wire is built, and the DATA NEVER LEAVES MEMORY: `launch` is set from a
// `launchConfigs` frame and cleared only when the socket effect re-runs, which
// is keyed on `sessionId` alone (BrowserSegment.tsx:127, :226-232, dep array
// :317). A page loading does not touch it. So this is a gate, not a fetch.
//
// WHAT THIS FILE PINS, and why each one is a different KIND of check:
//  1. the same rows, from the same component — not a second rendering that can
//     drift from the empty state;
//  2. the rows reach the reader while a page is open — the defect itself;
//  3. the dismissal is the house's, not a new one — `menuDismiss.ts` already
//     answers the modal question card 255 walked into.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartPage, LaunchMenu } from "./BrowserSegment";
import type { LaunchList } from "./liveView";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const lang = currentLang();

const list = (n: number): LaunchList => ({
  ok: true,
  sentence: null,
  skipped: 0,
  configs: Array.from({ length: n }, (_, i) => ({
    name: `app-${i}`,
    address: `http://localhost:${8080 + i}/`,
    attaches: false,
    up: false,
    exitCode: null,
  })),
});

const menu = (launch: LaunchList | null, open = true): string =>
  renderToStaticMarkup(
    <LaunchMenu
      launch={launch}
      playing={null}
      onPlay={() => {}}
      open={open}
      onOpenChange={() => {}}
      onRefresh={() => {}}
    />,
  );

describe("the launch configurations are reachable with a page open", () => {
  it("renders the SAME rows the start page does", () => {
    // Not "the menu contains the name" — that would pass on a second, drifting
    // rendering. The whole row markup of StartPage must appear inside the menu,
    // so the two cannot diverge without this going red.
    const l = list(2);
    const start = renderToStaticMarkup(<StartPage launch={l} playing={null} onPlay={() => {}} />);
    const rows = start.slice(start.indexOf('<ul class="browser-start-list"'), start.lastIndexOf("</ul>") + 5);
    expect(rows).toContain("browser-start-row");
    expect(menu(l)).toContain(rows);
  });

  it("keeps the port readable, which card 335 had to fix once already", () => {
    // A popover is narrower than a panel. Card 335 split the address so the
    // ellipsis eats `http://localho…` and never `:8080/`, and added the tooltip.
    // If the menu renders its own row, that work is silently undone here.
    const html = menu(list(1));
    expect(html).toContain('class="browser-start-port"');
    expect(html).toContain(">:8080/<");
    expect(html).toContain('title="http://localhost:8080/"');
  });

  it("says the same thing as the start page when there are none", () => {
    // The empty state is the sentence the owner is reading right now. One
    // source, or the menu grows its own wording the next time someone edits it.
    const empty: LaunchList = { ok: true, sentence: null, skipped: 0, configs: [] };
    expect(menu(empty)).toContain(t(lang, "browser.start.none"));
  });

  it("renders nothing at all when it is closed", () => {
    // A popover whose contents are in the DOM while closed is a popover that
    // can be reached by keyboard and read by a screen reader when it should not
    // be. Both directions, because "renders when open" alone passes on a menu
    // that always renders.
    expect(menu(list(2), false)).not.toContain("browser-start-row");
    expect(menu(list(2), true)).toContain("browser-start-row");
  });

  it("is labelled and announces its own state", () => {
    const html = menu(list(1));
    expect(html).toContain(t(lang, "browser.launchMenu"));
    expect(html).toContain('aria-expanded="true"');
    expect(menu(list(1), false)).toContain('aria-expanded="false"');
  });
});

describe("both faces reach it, and the guard compares them", () => {
  // CARD 344 measured how a parity claim fails here: card 227 says the two
  // faces carry "the same control row", and the two tests that hold it type the
  // SAME five i18n keys in two files. A sixth control on one face turns neither
  // red. So this guard does not type a list — it reads the two face components
  // out of the source and compares what they mount.
  const src = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");

  /** The body of one face component, from its declaration to the next one. */
  const faceBody = (name: string): string => {
    const at = src.indexOf(`export function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport function ", at + 1);
    return src.slice(at, next < 0 ? src.length : next);
  };

  it("mounts the launch menu on BOTH faces", () => {
    for (const face of ["WebFaceView", "DesktopFaceView"]) {
      expect(faceBody(face)).toContain("<LaunchMenu");
    }
  });

  it("hands both faces the same three props, compared rather than listed", () => {
    // The comparison IS the check: whatever props one face passes, the other
    // must pass the same names. A face that quietly drops `playing` would leave
    // its play buttons enabled during a launch.
    const propsOf = (face: string): string[] => {
      const body = faceBody(face);
      const at = body.indexOf("<LaunchMenu");
      const tag = body.slice(at, body.indexOf("/>", at));
      return [...tag.matchAll(/(\w+)=\{/g)].map((m) => m[1]).sort();
    };
    const web = propsOf("WebFaceView");
    expect(web).toContain("launch");
    expect(web).toContain("playing");
    expect(web).toContain("onPlay");
    expect(propsOf("DesktopFaceView")).toEqual(web);
  });
});

describe("the state chips are not stale", () => {
  // CRITERION 3, and it is a defect the ask uncovered rather than a nicety.
  // `launchListFrame` is sent on exactly two occasions — socket open
  // (BrowserSegment.tsx:250) and after a play (:294) — so a session left open
  // for an hour shows the running/exited chips as they were an hour ago. On the
  // start page that was survivable, because the start page is only reachable
  // before anything has run. In a menu reachable at any time it is a lie with a
  // green dot on it.
  it("asks for the list again each time it opens, and not while it is closed", () => {
    // The render only proves the component ACCEPTS the callback; server
    // rendering runs no effects, so whether it CALLS it is read off the source
    // below. A counter here would have been a number nothing could change.
    const render = (open: boolean): void => {
      renderToStaticMarkup(
        <LaunchMenu
          launch={list(1)}
          playing={null}
          onPlay={() => {}}
          open={open}
          onOpenChange={() => {}}
          onRefresh={() => {}}
        />,
      );
    };
    // Server rendering runs effects nowhere, so the refresh is asserted on the
    // component's OWN contract instead: it must accept the callback and name it
    // in the effect that watches `open`. Read off disk, the way the parity
    // guard above does — a render-time assertion here would pass on a component
    // that never calls it.
    render(false);
    render(true);

    // THE FIRST DRAFT OF THIS ASSERTION SURVIVED ITS OWN BITE, and that is worth
    // keeping in writing. It read `body.toContain("onRefresh")` plus a lazy
    // regex — and replacing the CALL `onRefresh();` with `void 0;` left it
    // green, because the name still appears in the prop declaration, in the
    // destructure and in the next effect's dependency array `[open, onRefresh]`.
    // The lazy `[\s\S]*?` walked straight past the gutted effect into that
    // array. Same shape as the hand-lists card 312 found: an assertion that
    // cannot go red for the thing it is named after.
    //
    // So the check is now on the CALL, in the effect that watches `open`, read
    // as one balanced block rather than as a span between two landmarks.
    const src = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
    const at = src.indexOf("function LaunchMenu(");
    const body = src.slice(at, src.indexOf("\nexport function StartPage", at));
    const effects = [...body.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)].map((m) => m[1]);
    expect(effects.length).toBeGreaterThan(0);
    const refreshing = effects.filter((e) => /\bonRefresh\(\)/.test(e));
    expect(refreshing).toHaveLength(1);
    // …and it is guarded on `open`, so it fires on opening rather than on every
    // render of the header.
    expect(refreshing[0]).toContain("if (!open) return;");
  });

  it("both faces hand it the refresh, compared rather than listed", () => {
    const src = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");
    const faceBody = (name: string): string => {
      const at = src.indexOf(`export function ${name}(`);
      const next = src.indexOf("\nexport function ", at + 1);
      return src.slice(at, next < 0 ? src.length : next);
    };
    for (const face of ["WebFaceView", "DesktopFaceView"]) {
      const body = faceBody(face);
      const tag = body.slice(body.indexOf("<LaunchMenu"), body.indexOf("/>", body.indexOf("<LaunchMenu")));
      expect(tag).toContain("onRefresh");
      expect(tag).toContain("launchListFrame");
    }
  });
});

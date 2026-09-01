// Card 339 — the terminal loses every tab when the panel closes.
//
// The owner: "das terminal setzt sich immer zurück wenn ich es zumache und
// wieder starte. alle tabs weg uns state auch". Measured end to end before a
// line was written, because the card named three possible graves and the fix
// differs for each:
//
//   the strip      TerminalPane's useState is component-local. Nothing wrote it
//                  anywhere, so closing the panel forgot it. THE WEB'S FAULT.
//   the unmount    RightPanel drops a closed panel out of `columns`, so the
//                  <section> and everything under it leaves the tree. By
//                  design: card 219 made closing the deliberate way to end a
//                  shell, and folding (display:none) the way to keep one.
//   the PTY        the unmount closes the socket; ShellSocketHandler's
//                  afterConnectionClosed reaps the shell; ShellRegistry is
//                  keyed by SOCKET ID and the wire carries no shell name, so
//                  there is nothing on the server left to reattach to.
//
// All three are real, and only the first is fixable in this project. This file
// is therefore option A of the card, and A is a deliberate half: the seats come
// back, the shells do not, AND THE STRIP SAYS SO. Option B — a PTY that
// outlives its panel — changes the server's guarantee that a shell dies with
// its client, which is a security surface and the owner's call, not an agent's.
//
// So the guarded property is not "the tabs are back". It is "the tabs are back
// AND a restored tab is distinguishable from a live one until it is used",
// which is criterion 2, and which is the difference between this and card
// 303's defect.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalPane } from "./TerminalPane";
import {
  SHELL_MAX_TABS,
  closeTab,
  emptyTabs,
  openTab,
  restoreTabs,
  serializeTabs,
  touchTab,
} from "./shellTabs";
import { __getState, __resetForTests, DEFAULT_LAYOUT, hydrateLayout, setDockTermTabs } from "../state/layout";

beforeEach(() => __resetForTests());

function strip(stored: string): string {
  setDockTermTabs(stored);
  return renderToStaticMarkup(<TerminalPane sessionId="s1" />);
}

/** How many tabs the strip drew, and how many of those it marked as restored. */
function counts(html: string): { tabs: number; restored: number } {
  return {
    // role="tab" is one per seat. Counting the CLASS would also catch
    // term-tab-pick and term-tab-close and report ten seats for three.
    tabs: html.split('role="tab"').length - 1,
    restored: html.split("term-tab--restored").length - 1,
  };
}

describe("the strip survives the panel, as a strip (card 339)", () => {
  it("serializes the ids and the focus, and brings exactly those back", () => {
    let state = openTab(openTab(openTab(emptyTabs())));
    state = closeTab(state, 2);
    expect(serializeTabs(state)).toBe("1,3~3");
    const back = restoreTabs(serializeTabs(state));
    expect(back.tabs.map((t) => t.id)).toEqual([1, 3]);
    expect(back.active).toBe(3);
    // Never reused: a new tab after a restore starts above every id that came
    // back, or a closing socket's late callbacks could land in its successor.
    expect(openTab(back).tabs[2].id).toBe(4);
  });

  it("marks every restored tab, and marks nothing on a fresh strip", () => {
    expect(restoreTabs("1,2~2").tabs.every((t) => t.restored === true)).toBe(true);
    expect(restoreTabs("").tabs).toEqual([{ id: 1 }]);
  });

  it("clears the mark when the operator types into that tab, and only that one", () => {
    const back = restoreTabs("1,2~1");
    const used = touchTab(back, 1);
    expect(used.tabs[0].restored).toBeUndefined();
    expect(used.tabs[1].restored).toBe(true);
    // Runs on every keystroke: an unchanged strip must be the SAME object or
    // the tab bar re-renders for the life of the shell.
    expect(touchTab(used, 1)).toBe(used);
    expect(touchTab(used, 99)).toBe(used);
  });

  it("a stored strip from an older build never throws and never over-seats", () => {
    for (const junk of ["", "~", "abc~xyz", "0,-1,1.5~9", "{}", "1,1,1~1"]) {
      expect(() => restoreTabs(junk)).not.toThrow();
    }
    expect(restoreTabs("abc~xyz").tabs.map((t) => t.id)).toEqual([1]);
    expect(restoreTabs("1,1,1~1").tabs.map((t) => t.id)).toEqual([1]);
    // A focus that is not among the tabs falls back rather than pointing at a
    // pane that is not there.
    expect(restoreTabs("4,5~9").active).toBe(4);
    // A field that is not a string at all (a hand-edited blob, an older build
    // writing something else under the key).
    expect(restoreTabs(42).tabs).toEqual([{ id: 1 }]);
    expect(restoreTabs(null).tabs).toEqual([{ id: 1 }]);
  });

  it("never restores more shells than a session may hold", () => {
    const asked = Array.from({ length: SHELL_MAX_TABS + 5 }, (_, i) => i + 1).join(",");
    expect(restoreTabs(`${asked}~1`).tabs).toHaveLength(SHELL_MAX_TABS);
  });
});

describe("the store field takes the same road as every other dock field", () => {
  it("starts empty and stores what it is given", () => {
    // Also the emit: set() returns EARLY when its field-by-field comparison
    // says nothing changed, so a field missing from that chain is written to
    // `next` and then thrown away. The read below would be "" in that case.
    expect(DEFAULT_LAYOUT.dockTermTabs).toBe("");
    setDockTermTabs("1,2~2");
    expect(__getState().dockTermTabs).toBe("1,2~2");
  });

  it("and so does every OTHER field — the chain is walked, not remembered", () => {
    // layout.ts names this trap in prose ("a field added to LayoutState and
    // NOT to this list is stored and never notifies anybody") and nothing has
    // ever checked it. Derived from DEFAULT_LAYOUT rather than typed here,
    // because a hand-list guarded by a test typing the same hand-list is two
    // copies of one lie — card 312, three times in one card.
    const src = readFileSync(path.join(__dirname, "..", "state", "layout.ts"), "utf8");
    const chain = src.slice(src.indexOf("function set("), src.indexOf("return; // no change"));
    const missing = Object.keys(DEFAULT_LAYOUT).filter(
      (field) => !chain.includes(`next.${field} === state.${field}`),
    );
    expect(missing, "these fields are stored and never notify").toEqual([]);
  });

  it("normalises a junk field on hydrate rather than carrying it into persist", () => {
    expect(hydrateLayout({ dockAgents: "open", dockTermTabs: 42 }, null).dockTermTabs).toBe("");
    expect(hydrateLayout({ dockAgents: "open", dockTermTabs: "1,2~2" }, null).dockTermTabs).toBe("1,2~2");
    // A pre-card blob has no such field and must not invent one.
    expect(hydrateLayout({ activeRightTab: "files" }, null).dockTermTabs).toBe("");
  });
});

describe("a restored tab does not look like a live one", () => {
  it("brings back the seats it stored", () => {
    expect(counts(strip("1,2,3~2")).tabs).toBe(3);
    expect(counts(strip("")).tabs).toBe(1);
  });

  it("marks every restored seat, and a fresh strip carries no mark", () => {
    expect(counts(strip("1,2,3~2")).restored).toBe(3);
    expect(counts(strip("")).restored).toBe(0);
  });

  it("says in words that the shell is new and the scrollback is gone", () => {
    // The class is for the eye; the sentence is what a reader (or a screen
    // reader) actually gets. A mark nobody can read is decoration.
    const html = strip("1,2~1");
    expect(html).toContain("term-restored-note");
    expect(html).toMatch(/scrollback/i);
  });

  it("writes the strip back to the layout store", () => {
    // A SOURCE PIN, and it is one on purpose: this suite runs in plain Node
    // with no DOM, so the effect that persists never fires here. What can be
    // checked is that the pane reaches the store at all — the round trip
    // itself is pinned by the model and store cases above.
    const src = readFileSync(path.join(__dirname, "TerminalPane.tsx"), "utf8");
    expect(src).toContain("setDockTermTabs(serializeTabs(");
    expect(src).toContain("restoreTabs(");
  });
});

describe("how many shells can be open at once (card 339, criterion 5)", () => {
  it("the strip's cap is the server's cap, read off the server", () => {
    // shellTabs.ts has claimed "mirrored from ShellRegistry.MAX_PER_SESSION"
    // since card 93 with nothing checking it. The restore is the first thing
    // that can ask for several shells in one gesture, so the mirror stops
    // being a comment here.
    const registry = readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "spectro-server/src/main/java/dev/spectroscope/server/shell/ShellRegistry.java",
      ),
      "utf8",
    );
    const perSession = /static final int MAX_PER_SESSION = (\d+);/.exec(registry);
    expect(perSession, "MAX_PER_SESSION is not where this test looks").not.toBeNull();
    expect(SHELL_MAX_TABS).toBe(Number(perSession?.[1]));
  });
});

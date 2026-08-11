// View-state continuity: orientation, cursor and picked node live in App, the
// way the run itself was lifted — so leaving for sessions or fleets and coming
// back finds the exact view, not a reset one.
//
// The proof is structural, in this tree's own idiom: the view renders as a pure
// function of the lifted state. Two renders from one state object are the same
// markup, which is precisely what an unmount/remount with App-held state is.
// Only the ORIENTATION persists across reloads — a view preference, like a
// theme. The run deliberately does not (see App.tsx: a file picker cannot be
// re-read without a user gesture), and cursor/picked mean nothing without it.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StateGraphView } from "./StateGraphView";
import {
  __setViewStateHooks,
  DEFAULT_VIEW,
  initialViewState,
  parseOrientation,
  rememberOrientation,
  type StateGraphViewState,
} from "./viewState";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");
const lang = currentLang();

// In-memory storage seam, the designPrefs suite's pattern: plain Node has no
// localStorage, so the module takes injected get/set.
let store: string | null = null;
beforeEach(() => {
  store = null;
  __setViewStateHooks({ get: () => store, set: (v) => (store = v) });
});

describe("the orientation preference survives a reload", () => {
  it("restores a stored orientation on mount", () => {
    store = "vertical";
    expect(initialViewState()).toEqual({ ...DEFAULT_VIEW, orientation: "vertical" });
  });

  it("starts horizontal when nothing is stored, and on junk", () => {
    expect(initialViewState()).toEqual(DEFAULT_VIEW);
    expect(parseOrientation("sideways")).toBe("horizontal");
    expect(parseOrientation(null)).toBe("horizontal");
    expect(parseOrientation("vertical")).toBe("vertical");
  });

  it("remembers an orientation change, and only the orientation", () => {
    rememberOrientation("vertical");
    expect(store).toBe("vertical");
    rememberOrientation("horizontal");
    expect(store).toBe("horizontal");
  });
});

describe("the view is a pure function of the lifted state", () => {
  const view: StateGraphViewState = { orientation: "vertical", cursor: 2, picked: "router" };
  const render = (v: StateGraphViewState): string =>
    renderToStaticMarkup(
      <StateGraphView
        graphJsonl={GRAPH}
        stateJsonl={null}
        source="probe.graph.jsonl"
        view={v}
        onView={() => {}}
      />,
    );

  it("draws orientation, cursor and picked node from the App-owned state", () => {
    const html = render(view);
    // The cursor: record 3 of the run, not the run's end.
    expect(html).toMatch(/record 3\/\d+/);
    expect(html).toContain(t(lang, "sg.inFlight"));
    // The orientation: the vertical button is the one marked on.
    expect(html).toContain(`is-on">${t(lang, "sg.vertical")}`);
    // The picked node: the panel answers about router, not the empty state.
    expect(html).toContain(`sg-panel-name mono">router<`);
  });

  // An unmount/remount with App-held state IS a second render from the same
  // object; if these two differ, something inside the view still owns state.
  it("clamps a stale cursor to the last record instead of pointing past the file", () => {
    // The sidebar rail can swap the run UNDER the lifted view: a cursor at
    // 9999 over a 36-record run must land on the end, not on records[9999].
    const html = render({ orientation: "horizontal", cursor: 9999, picked: null });
    expect(html).toMatch(/record 36\/36/);
  });

  it("renders identically twice from one state object — the remount case", () => {
    expect(render(view)).toBe(render(view));
  });

  it("null cursor still reads as the whole, finished run", () => {
    const html = render({ ...DEFAULT_VIEW });
    expect(html).toContain(t(lang, "sg.complete"));
  });
});

// Card 586, task 9: the State graph segment's keys and file picker belong to
// that segment. The wide run view draws the same view with `keys={false}` and
// no file loader: no document listener for space and the arrows, no Load.
//
// StateGraphView runs under HookHost, so its effects run as in the window;
// `document` is a stand-in that records its listeners.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateGraphView } from "./StateGraphView";
import { DEFAULT_VIEW } from "./viewState";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import { flatten, type El } from "../testkit/chatHost";
import { HookHost } from "../testkit/hookHost";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");

let listeners: string[] = [];

beforeEach(() => {
  listeners = [];
  vi.stubGlobal("document", {
    addEventListener: (type: string) => listeners.push(type),
    removeEventListener: () => {},
  });
});
afterEach(() => vi.unstubAllGlobals());

function host(extra: { keys?: boolean; onLoadFile?: () => void }): HookHost<unknown> {
  return new HookHost(() =>
    StateGraphView({
      graphJsonl: GRAPH,
      stateJsonl: null,
      source: "run",
      view: DEFAULT_VIEW,
      onView: () => {},
      ...extra,
    }),
  );
}

const loadButtons = (h: HookHost<unknown>): El[] =>
  flatten(h.value as El).filter(
    (el) => el.type === "button" && el.props.children === t(currentLang(), "sg.load"),
  );

describe("StateGraphView's keys and Load (card 586)", () => {
  it("by default listens to the document's keys and offers Load with a loader", () => {
    const h = host({ onLoadFile: () => {} });
    expect(listeners).toEqual(["keydown"]);
    expect(loadButtons(h)).toHaveLength(1);
    h.unmount();
  });

  it("with keys off adds no document listener", () => {
    const h = host({ keys: false, onLoadFile: () => {} });
    expect(listeners).toEqual([]);
    h.unmount();
  });

  it("without a loader draws no Load button", () => {
    const h = host({});
    expect(loadButtons(h)).toEqual([]);
    expect(
      flatten(h.value as El).some((el) => el.props.className === "sg-head-actions"),
      "premise: the header's actions are drawn",
    ).toBe(true);
    h.unmount();
  });
});

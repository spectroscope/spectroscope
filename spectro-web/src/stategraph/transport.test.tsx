// The transport's replay half: a clock that advances the cursor at the
// reference's per-record cadence, and the keyboard grammar that drives it.
//
// The clock is a DOM-free closure (player.ts) for the same reason layout.ts is
// pure: fake timers can drive it in plain Node, where the component's effects
// never run. The component only wires it to state, and THAT wiring is asserted
// the way this tree asserts markup — through react-dom/server.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StateGraphView } from "./StateGraphView";
import { DEFAULT_VIEW } from "./viewState";
import { createReplayClock, stepDelayMs, transportIntent } from "./player";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");
const lang = currentLang();

describe("stepDelayMs — the reference's cadence, scaled by speed", () => {
  // Timestamp gaps 100 and 400 ms; the third pair has no usable ts.
  const records = [{ ts: 1000 }, { ts: 1100 }, { ts: 1500 }, { ts: 0 }];

  it("scales the recorded gap by the speed", () => {
    expect(stepDelayMs(records, 0, 1)).toBe(100);
    expect(stepDelayMs(records, 1, 1)).toBe(400);
    expect(stepDelayMs(records, 1, 4)).toBe(100);
    expect(stepDelayMs(records, 0, 0.5)).toBe(200);
  });

  it("clamps to the reference's 45..760 window", () => {
    expect(stepDelayMs([{ ts: 1 }, { ts: 2 }], 0, 1)).toBe(45);
    expect(stepDelayMs([{ ts: 1000 }, { ts: 90000 }], 0, 1)).toBe(760);
  });

  it("falls back to 260/speed when a timestamp is missing", () => {
    expect(stepDelayMs(records, 2, 1)).toBe(260);
    expect(stepDelayMs(records, 2, 2)).toBe(130);
  });
});

describe("transportIntent — the reference's keyboard grammar", () => {
  const base = { tag: "body", inPanel: false, editable: false, modified: false };

  it("space toggles play, arrows step, home/end jump", () => {
    expect(transportIntent({ ...base, key: " " })).toBe("toggle");
    expect(transportIntent({ ...base, key: "ArrowRight" })).toBe("next");
    expect(transportIntent({ ...base, key: "ArrowLeft" })).toBe("prev");
    expect(transportIntent({ ...base, key: "Home" })).toBe("first");
    expect(transportIntent({ ...base, key: "End" })).toBe("last");
    expect(transportIntent({ ...base, key: "x" })).toBeNull();
  });

  // Space belongs to whatever the reader has focused inside the panel — a
  // disclosure, a scrollable value. The transport may not steal it.
  it("does not steal space while focus sits inside the panel", () => {
    expect(transportIntent({ ...base, key: " ", inPanel: true })).toBeNull();
    expect(transportIntent({ ...base, key: "ArrowRight", inPanel: true })).toBe("next");
  });

  it("ignores arrows in inputs, and everything in text fields", () => {
    expect(transportIntent({ ...base, key: "ArrowRight", tag: "input", inputType: "range" })).toBeNull();
    expect(transportIntent({ ...base, key: " ", tag: "input", inputType: "range" })).toBe("toggle");
    expect(transportIntent({ ...base, key: " ", tag: "input", inputType: "text" })).toBeNull();
    expect(transportIntent({ ...base, key: "Home", tag: "textarea" })).toBeNull();
    expect(transportIntent({ ...base, key: " ", tag: "select" })).toBeNull();
    expect(transportIntent({ ...base, key: " ", editable: true })).toBeNull();
  });

  // Cmd+Arrow is the app's own history hotkey (App.tsx) — a modified key is
  // never this transport's business.
  it("ignores modified keys", () => {
    expect(transportIntent({ ...base, key: "ArrowRight", modified: true })).toBeNull();
    expect(transportIntent({ ...base, key: " ", modified: true })).toBeNull();
  });
});

describe("createReplayClock — advance, pause at the end, restart", () => {
  const records = [{ ts: 1000 }, { ts: 1100 }, { ts: 1500 }, { ts: 1600 }];
  let at = 0;
  let speed: number | "instant" = 1;
  let seeks: number[] = [];
  let playingLog: boolean[] = [];

  const clock = () =>
    createReplayClock({
      count: () => records.length,
      cursor: () => at,
      seek: (i) => {
        at = i;
        seeks.push(i);
      },
      delay: (i) => (speed === "instant" ? "instant" : stepDelayMs(records, i, speed)),
      onPlaying: (p) => playingLog.push(p),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    at = 0;
    speed = 1;
    seeks = [];
    playingLog = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the cursor at the recorded cadence and pauses at the last record", () => {
    const c = clock();
    c.play();
    expect(c.playing()).toBe(true);
    vi.advanceTimersByTime(100); // 1000 -> 1100
    expect(at).toBe(1);
    vi.advanceTimersByTime(400); // 1100 -> 1500
    expect(at).toBe(2);
    vi.advanceTimersByTime(100); // 1500 -> 1600, the last record
    expect(at).toBe(3);
    expect(c.playing()).toBe(false);
    expect(playingLog).toEqual([true, false]);
    vi.advanceTimersByTime(60_000); // nothing keeps ticking after the end
    expect(seeks).toEqual([1, 2, 3]);
  });

  it("a speed change takes effect on the pending step", () => {
    const c = clock();
    c.play();
    vi.advanceTimersByTime(100);
    expect(at).toBe(1); // pending step would fire in 400 ms at 1x
    speed = 4;
    c.reschedule();
    vi.advanceTimersByTime(100); // 400/4
    expect(at).toBe(2);
    c.pause();
  });

  it("instant jumps to the end and pauses", () => {
    speed = "instant";
    const c = clock();
    c.play();
    expect(at).toBe(3);
    expect(c.playing()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("play at the end restarts from the first record, like the reference", () => {
    at = records.length - 1;
    const c = clock();
    c.play();
    expect(at).toBe(0);
    vi.advanceTimersByTime(100);
    expect(at).toBe(1);
    c.dispose();
    vi.advanceTimersByTime(60_000);
    expect(at).toBe(1); // a disposed clock stops cold
  });

  it("toggle is play/pause, and pause survives being called twice", () => {
    const c = clock();
    c.toggle();
    expect(c.playing()).toBe(true);
    c.toggle();
    c.pause();
    expect(c.playing()).toBe(false);
    expect(playingLog).toEqual([true, false]);
  });
});

describe("the transport bar carries the play control and the speed select", () => {
  const html = renderToStaticMarkup(
    <StateGraphView
      graphJsonl={GRAPH}
      stateJsonl={null}
      source="probe.graph.jsonl"
      view={DEFAULT_VIEW}
      onView={() => {}}
    />,
  );

  it("offers play (paused at mount) with a localised label", () => {
    expect(html).toContain(`aria-label="${t(lang, "sg.play")}"`);
  });

  it("offers the five reference speeds", () => {
    for (const v of ["0.5", "1", "2", "4", "instant"]) {
      expect(html).toContain(`value="${v}"`);
    }
    expect(html).toContain(t(lang, "sg.instant"));
    expect(html).toContain(`aria-label="${t(lang, "sg.speed")}"`);
  });
});

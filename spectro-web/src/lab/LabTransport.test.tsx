// Card 299: the transport says where the interesting part is.
//
// Rendered with react-dom/server like the other view suites — no DOM in this
// gate. What is pinned here is the WIRING: that the pure readings reach the
// markup at all, that the pills carry a multiplier vocabulary with a 1x
// baseline, that the ticks are real controls with the run's own words on them,
// and that the clock stays silent on a recording that never carried one.

import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEvent } from "../events";
import { LabTransport } from "./LabTransport";
import {
  MARK_MIN_GAP_PCT,
  __resetForTests,
  chapterMarks,
  loadReplay,
  setSpeed,
  step,
} from "../state/stepper";

const T = 1700000000000;
const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

/** A short run with a readable span and two things worth a chapter. */
const timed: RunEvent[] = [
  ev({ type: "run_start", runId: "r1", agentId: "main", prompt: "p", ts: T }),
  ev({ type: "turn_start", agentId: "main", turn: 1, ts: T + 1000 }),
  ev({
    type: "permission_request",
    agentId: "main",
    callId: "c1",
    name: "write_file",
    input: {},
    ts: T + 2000,
  }),
  ev({ type: "permission_decision", callId: "c1", allowed: false, ts: T + 3000 }),
  ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: T + 5000 }),
];

/** The same run with every line on one millisecond: no span was recorded. */
const untimed: RunEvent[] = timed.map((e) => ev({ ...(e as unknown as Record<string, unknown>), ts: T }));

const render = (): string => renderToStaticMarkup(<LabTransport running={false}>{null}</LabTransport>);

beforeEach(() => __resetForTests());

describe("the speed pills", () => {
  it("offers five multipliers, 1x among them", () => {
    loadReplay("s1", timed);
    const html = render();
    for (const pill of ["0.25×", "0.5×", "1×", "2×", "5×"]) expect(html).toContain(`>${pill}<`);
  });

  it("lights 1x at the shipped pace and moves the light when the pace moves", () => {
    loadReplay("s1", timed);
    expect(render()).toContain('aria-checked="true" class="lab-speed-pill lab-speed-pill--on">1×<');
    setSpeed(250); // 5x
    const html = render();
    expect(html).toContain('aria-checked="true" class="lab-speed-pill lab-speed-pill--on">5×<');
    expect(html).not.toContain('aria-checked="true" class="lab-speed-pill lab-speed-pill--on">1×<');
  });

  it("says the millisecond cost of each pill rather than implying it", () => {
    loadReplay("s1", timed);
    const html = render();
    expect(html).toContain("5000 ms"); // 0.25x, exactly the slow bound
    expect(html).toContain("1250 ms"); // 1x
    expect(html).toContain("250 ms"); // 5x
  });
});

describe("jump to the end", () => {
  it("is a control of its own beside the reset", () => {
    loadReplay("s1", timed);
    expect(render()).toContain("Jump to the end");
  });
});

describe("the chapter ticks", () => {
  it("draws one clickable tick per chapter the run carries", () => {
    loadReplay("s1", timed);
    const html = render();
    const ticks = html.match(/class="lab-mark lab-mark--/g) ?? [];
    expect(ticks).toHaveLength(chapterMarks(timed).length);
    expect(ticks).toHaveLength(4); // turn 1, the gate, the refusal, the end
  });

  it("puts the run's own words on each tick, and its kind in the class", () => {
    loadReplay("s1", timed);
    const html = render();
    expect(html).toContain("lab-mark--gate");
    expect(html).toContain("lab-mark--denied");
    expect(html).toContain("refused at the gate");
    expect(html).toContain("the gate stopped write_file");
  });

  it("draws nothing at all for a run with no chapters", () => {
    loadReplay("s2", [ev({ type: "text_delta", agentId: "main", text: "hi", ts: T })]);
    expect(render()).not.toContain("lab-mark lab-mark--");
  });

  // The fix round. Each tick's POSITION is the whole point of the card, and it
  // was pinned nowhere: replacing left: ${m.pct}% with left: 0% stacked every
  // chapter on the bar's left edge and the full suite stayed green.
  it("puts each tick where its own reading says, not on the bar's edge", () => {
    loadReplay("s1", timed);
    const html = render();
    // Measured off this very fixture: boundaries [0,1,2,3,4,5], so the turn
    // sits at 2/5 of the bar and the end at the far end of it.
    expect(html).toContain('lab-mark--turn" style="left:40%"');
    expect(html).toContain('lab-mark--gate" style="left:60%"');
    expect(html).toContain('lab-mark--end" style="left:100%"');
    // …and no two chapters share a place, which is what a collapsed reading
    // (left: 0%, or the same pct for all) would look like.
    const lefts = [...html.matchAll(/lab-mark--\w+" style="left:([\d.]+)%"/g)].map((m) => m[1]);
    expect(new Set(lefts).size).toBe(lefts.length);
  });

  it("thins a crowded run instead of walling the slider in", () => {
    // 80 turns on a bar 81 boundaries long puts the ticks 1.2% apart. At the
    // 11px hit box lab.css gives them that is a continuous row of buttons; the
    // density floor is what keeps them apart.
    const crowded = [
      ...Array.from({ length: 80 }, (_, i) =>
        ev({ type: "turn_start", agentId: "main", turn: i + 1, ts: T + i }),
      ),
      ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: T + 80 }),
    ];
    loadReplay("s4", crowded);
    const drawn = (render().match(/class="lab-mark lab-mark--/g) ?? []).length;
    expect(chapterMarks(crowded).length).toBe(81);
    expect(drawn).toBeLessThan(81);
    expect(drawn).toBeLessThanOrEqual(Math.floor(100 / MARK_MIN_GAP_PCT) + 1);
  });

  it("keeps the ticks out of the tab order", () => {
    // They are a pointer shortcut to a boundary the slider itself reaches with
    // an arrow key. Left tabbable, a long run wedges dozens of stops between
    // the slider and the speed pills with no way past them.
    loadReplay("s1", timed);
    const html = render();
    const ticks = (html.match(/class="lab-mark lab-mark--/g) ?? []).length;
    expect(ticks).toBe(4);
    expect((html.match(/tabindex="-1"[^>]*class="lab-mark /g) ?? []).length).toBe(ticks);
  });
});

describe("the clock", () => {
  it("reads elapsed over total, and the elapsed half MOVES with the cursor", () => {
    loadReplay("s1", timed);
    expect(render()).toContain("0:00 / 0:05");
    step(); // run_start
    step(); // turn_start, at t+1s
    step(); // the gate, at t+2s
    expect(render()).toContain("0:02 / 0:05");
  });

  it("says nothing when the recording carries no span", () => {
    loadReplay("s3", untimed);
    const html = render();
    expect(html).not.toContain("lab-clock");
    expect(html).not.toContain("0:00 /");
  });
});

describe('the "more" drawer', () => {
  // CARD 303 rests a decision on this: `.lab-advanced` is left out of
  // TRANSPORT_YIELD_ORDER, so no width hides it, and the row wraps instead.
  // The reason is a fact about the markup rather than a memory of it, and this
  // is where the fact is measured — if a second tempo slider ever grows in the
  // row proper, the drawer stops being the only way to a tempo and the
  // decision above it is free to be revisited.
  const drawer = (html: string): { before: string; inside: string } => {
    const at = html.indexOf('<details class="lab-advanced">');
    expect(at, "the drawer must be in the row").toBeGreaterThan(-1);
    return { before: html.slice(0, at), inside: html.slice(at) };
  };
  const count = (s: string, cls: string) => (s.match(new RegExp(`class="${cls}"`, "g")) ?? []).length;

  it("is the only place in the row that carries a grain choice", () => {
    loadReplay("s1", timed);
    const html = render();
    const { before, inside } = drawer(html);
    expect(count(html, "lab-grain")).toBe(1);
    expect(count(before, "lab-grain")).toBe(0);
    expect(count(inside, "lab-grain")).toBe(1);
  });

  it("is the only place in the row that carries a tempo slider", () => {
    // The speed PILLS are a different control and they do yield: five fixed
    // multipliers, against a continuous slider over the whole interval range.
    loadReplay("s1", timed);
    const html = render();
    const { before, inside } = drawer(html);
    expect(count(html, "lab-speed")).toBe(1);
    expect(count(before, "lab-speed")).toBe(0);
    expect(count(inside, "lab-speed")).toBe(1);
  });
});

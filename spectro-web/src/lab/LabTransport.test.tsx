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
import { __resetForTests, chapterMarks, loadReplay, setSpeed, step } from "../state/stepper";

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

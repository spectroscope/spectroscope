// Card 400: a long thinking block stopped following its newest line.
//
// This suite has no DOM, so the thinking body is a model with the three numbers
// the follow reads, and the stream is played in the order the browser and React
// were measured to deliver it (kanban/evidence/400/loop/bench-results): each
// frame first dispatches the scroll event of the body's last jump, then the
// transport folds the buffered lines into one commit. When the render is slow,
// the next frame comes before that commit's passive effect has run, so the
// scroll event of jump N is read after commit N+1 has already grown the box.
// On the base build 7c24ebcf every disarm with no input looked exactly like
// that on the bench: the event read 37 to 55.5 px from the bottom, one commit
// after a jump that had landed at the bottom, with that commit's effect not yet
// run. The fix build saw the same late reads, up to 74.5 px, and the body kept
// following.

import { describe, expect, it } from "vitest";
import { keyPull, READER_INTENT_WINDOW_MS, touchPull, wheelPull } from "./scrollPin";
import {
  distanceFromBottom,
  followsTheText,
  THINKING_FOLLOW_PX,
  thinkingFollow,
  type ScrollBox,
} from "./thinkingFollow";

/** .thinking-body: font-size 12 px at line-height 1.55. */
const LINE_PX = 12 * 1.55;
/** The body's floor ceiling (chat.css, --thinking-body-max). */
const CEILING_PX = 240;
/** Card 395's p90 for GLM 5.3's thinking stream, in lines per second. */
const GLM_P90_LPS = 141.9;

/** A thinking body as the browser keeps it. */
class Body implements ScrollBox {
  readonly clientHeight = CEILING_PX;
  /** Whether a scroll event is waiting for the next frame. */
  scrollPending = false;
  private top = 0;
  private content: number;

  constructor(lines: number) {
    this.content = lines * LINE_PX;
  }

  get scrollHeight(): number {
    return Math.max(this.clientHeight, this.content);
  }

  get scrollTop(): number {
    return this.top;
  }

  /** Clamped like the browser clamps it; a change queues one scroll event. */
  set scrollTop(value: number) {
    const next = Math.min(Math.max(0, value), this.scrollHeight - this.clientHeight);
    if (next === this.top) return;
    this.top = next;
    this.scrollPending = true;
  }

  append(lines: number): void {
    this.content += lines * LINE_PX;
  }
}

/** A clock the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * Plays a stream into one follow, frame by frame, with no reader input.
 *
 * @return the distance from the bottom once the stream has settled
 */
function stream(
  follow: ReturnType<typeof thinkingFollow>,
  body: Body,
  time: ReturnType<typeof clock>,
  opts: { linesPerSecond: number; seconds: number; slowRender: boolean; fps?: number },
): number {
  const fps = opts.fps ?? 60;
  const frames = Math.round(opts.seconds * fps);
  let produced = 0;
  let effectPending = false;
  const deliverScroll = (): void => {
    if (!body.scrollPending) return;
    body.scrollPending = false;
    follow.scrolled(body);
  };
  for (let i = 0; i < frames; i++) {
    time.advance(1000 / fps);
    deliverScroll();
    // React flushes a passive effect still pending before it renders again.
    if (effectPending) {
      follow.grew(body);
      effectPending = false;
    }
    const due = Math.floor(((i + 1) * opts.linesPerSecond) / fps) - produced;
    if (due <= 0) continue;
    produced += due;
    body.append(due);
    if (opts.slowRender) effectPending = true;
    else follow.grew(body);
  }
  for (let i = 0; i < 3; i++) {
    time.advance(1000 / fps);
    deliverScroll();
    if (effectPending) {
      follow.grew(body);
      effectPending = false;
    }
  }
  return distanceFromBottom(body);
}

function fresh(lines = 40): {
  follow: ReturnType<typeof thinkingFollow>;
  body: Body;
  time: ReturnType<typeof clock>;
} {
  const time = clock();
  const follow = thinkingFollow(time.now);
  const body = new Body(lines);
  follow.opened(body);
  body.scrollPending = false;
  follow.scrolled(body);
  return { follow, body, time };
}

describe("a fast thinking stream keeps following its own last line", () => {
  it("follows a burst at GLM's p90 rate to its end while renders are slow and nobody touches it", () => {
    const { follow, body, time } = fresh();
    const settled = stream(follow, body, time, { linesPerSecond: GLM_P90_LPS, seconds: 6, slowRender: true });
    expect(settled, `settled ${settled.toFixed(1)} px behind its newest line`).toBeLessThan(1);
    expect(follow.pinned()).toBe(true);
  });

  it("follows the same burst when renders are fast, as it always did", () => {
    const { follow, body, time } = fresh();
    const settled = stream(follow, body, time, {
      linesPerSecond: GLM_P90_LPS,
      seconds: 6,
      slowRender: false,
    });
    expect(settled).toBeLessThan(1);
    expect(follow.pinned()).toBe(true);
  });

  it("follows GLM's median rate the same way", () => {
    // 83 lines a second at 60 commits a second: one line or two per commit,
    // and two lines (37.2 px) already stand past the threshold.
    const { follow, body, time } = fresh();
    const settled = stream(follow, body, time, { linesPerSecond: 83, seconds: 6, slowRender: true });
    expect(settled, `settled ${settled.toFixed(1)} px behind its newest line`).toBeLessThan(1);
  });

  it("a stream of one line per commit is followed while renders are slow", () => {
    // The "manchmal": at a rate that never puts two lines into one commit the
    // late read stays at 18.6 px, inside the threshold, and even the old rule
    // kept following.
    const { follow, body, time } = fresh();
    const settled = stream(follow, body, time, { linesPerSecond: 30, seconds: 6, slowRender: true });
    expect(settled).toBeLessThan(1);
  });
});

describe("who scrolled decides, not where the box happens to stand", () => {
  it("a reader's wheel away disarms, the app's own jump read back after more growth does not", () => {
    // Negative: the component's jump lands at the bottom, the box grows by
    // three lines before the browser delivers that jump's scroll event, and
    // the event reads 55.8 px from the bottom with no reader anywhere.
    const { follow, body, time } = fresh(200);
    follow.grew(body);
    body.append(3);
    time.advance(8);
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    follow.scrolled(body);
    expect(follow.pinned()).toBe(true);
    follow.grew(body);
    expect(distanceFromBottom(body)).toBeLessThan(1);

    // Positive: a wheel notch up, and the box moving 120 px away under it.
    time.advance(400);
    follow.gesture(body, wheelPull(-120));
    body.scrollTop -= 120;
    follow.scrolled(body);
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    expect(follow.pinned()).toBe(false);
  });

  it("a touch drag away disarms", () => {
    const { follow, body } = fresh(200);
    follow.gesture(body, touchPull(40));
    body.scrollTop -= 80;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);
  });

  it("a scrolling key away disarms", () => {
    const { follow, body } = fresh(200);
    follow.gesture(body, keyPull("PageUp"));
    body.scrollTop -= CEILING_PX;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);
  });

  it("a grab of the scrollbar disarms before the thumb moves", () => {
    const { follow, body } = fresh(200);
    follow.gesture(body, "grab");
    expect(follow.pinned()).toBe(false);
  });

  it("a drag on an overlay scrollbar, heard only as a press, disarms by the way the box moves", () => {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, "unknown");
    expect(follow.pinned()).toBe(true);
    for (let i = 0; i < 5; i++) {
      time.advance(16);
      body.scrollTop -= 20;
      follow.scrolled(body);
    }
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    expect(follow.pinned()).toBe(false);
  });

  it("after a press, a jump's scroll event read late, after more growth, does not disarm", () => {
    // A click in the text while it streams: the press opens the gesture
    // window, so the jump's late scroll event counts as the reader's. It moved
    // toward the edge, and that is no pull away.
    const { follow, body, time } = fresh(200);
    follow.gesture(body, "unknown");
    body.append(3);
    follow.grew(body);
    body.append(4);
    time.advance(8);
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    follow.scrolled(body);
    expect(follow.pinned()).toBe(true);
    follow.grew(body);
    expect(distanceFromBottom(body)).toBeLessThan(1);
  });

  /**
   * A grab of the scrollbar, a drag away, and then, `after` ms later with no
   * gesture in between, a scroll event that finds the body at its bottom.
   *
   * @return whether the body follows after that last scroll event
   */
  function landAtTheBottomAfter(after: number): boolean {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, "grab");
    time.advance(16);
    body.scrollTop -= 200;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);
    time.advance(after);
    body.scrollTop = body.scrollHeight;
    follow.scrolled(body);
    expect(distanceFromBottom(body)).toBeLessThan(1);
    return follow.pinned();
  }

  /**
   * A press on the text, and then, `after` ms later with no gesture in
   * between, a scroll event that finds the body 80 px above its bottom.
   *
   * @return whether the body follows after that scroll event
   */
  function moveAwayAfter(after: number): boolean {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, "unknown");
    expect(follow.pinned()).toBe(true);
    time.advance(after);
    body.scrollTop -= 80;
    follow.scrolled(body);
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    return follow.pinned();
  }

  it("a scroll that lands at the bottom re-arms inside the gesture window and not once it has closed", () => {
    expect(landAtTheBottomAfter(16)).toBe(true);
    expect(landAtTheBottomAfter(READER_INTENT_WINDOW_MS)).toBe(false);
  });

  it("a scroll that moves the body away disarms inside the gesture window and not once it has closed", () => {
    expect(moveAwayAfter(16)).toBe(false);
    expect(moveAwayAfter(READER_INTENT_WINDOW_MS)).toBe(true);
  });
});

describe("a reader who scrolled away is never yanked back", () => {
  it("new text leaves the reader's position alone", () => {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, wheelPull(-100));
    body.scrollTop -= 100;
    follow.scrolled(body);
    const held = body.scrollTop;
    for (let i = 0; i < 50; i++) {
      time.advance(16);
      body.append(2);
      follow.grew(body);
      follow.scrolled(body);
    }
    expect(body.scrollTop).toBe(held);
  });

  it("text landing between the reader's notch and its scroll event does not swallow the notch", () => {
    // The race card 257 measured for the transcript: a jump in the same frame
    // as the notch erased it. The gesture takes the pin off first.
    const { follow, body } = fresh(200);
    const before = body.scrollTop;
    follow.gesture(body, wheelPull(-40));
    body.append(3);
    follow.grew(body);
    expect(body.scrollTop).toBe(before);
    expect(follow.pinned()).toBe(false);
  });

  it("a nudge smaller than the threshold is still the reader's", () => {
    const { follow, body } = fresh(200);
    follow.gesture(body, wheelPull(-20));
    body.scrollTop -= 20;
    follow.scrolled(body);
    const held = body.scrollTop;
    body.append(5);
    follow.grew(body);
    expect(body.scrollTop).toBe(held);
  });
});

describe("returning to the live edge re-engages the follow", () => {
  it("scrolling back down by hand to within the threshold re-arms, and the next line is followed", () => {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, wheelPull(-300));
    body.scrollTop -= 300;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);

    time.advance(50);
    follow.gesture(body, wheelPull(120));
    body.scrollTop += 280;
    follow.scrolled(body);
    const left = distanceFromBottom(body);
    expect(left).toBeGreaterThan(2);
    expect(left).toBeLessThanOrEqual(THINKING_FOLLOW_PX);
    expect(follow.pinned()).toBe(true);

    body.append(3);
    follow.grew(body);
    expect(distanceFromBottom(body)).toBeLessThan(1);
  });

  it("wheeling down while already at the bottom re-arms", () => {
    const { follow, body } = fresh(200);
    follow.gesture(body, "grab");
    expect(follow.pinned()).toBe(false);
    follow.gesture(body, wheelPull(100));
    expect(follow.pinned()).toBe(true);
  });

  it("reopening the panel mid-stream re-arms at the live edge", () => {
    const { follow, body, time } = fresh(200);
    follow.gesture(body, wheelPull(-300));
    body.scrollTop -= 300;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);

    const reopened = new Body(260);
    follow.opened(reopened);
    expect(follow.pinned()).toBe(true);
    expect(distanceFromBottom(reopened)).toBeLessThan(1);
    time.advance(8);
    reopened.append(3);
    follow.scrolled(reopened);
    expect(follow.pinned()).toBe(true);
  });

  it("after a reopen, a drag back to the edge re-arms although the last wheel before it pulled away", () => {
    // The reopen forgets the reader's old pull, as the transcript's setPin
    // does. Kept, the old "away" would refuse the re-arm when a later drag on
    // an overlay scrollbar (heard only as a press) lands at the bottom.
    const { follow, body, time } = fresh(200);
    follow.gesture(body, wheelPull(-300));
    body.scrollTop -= 300;
    follow.scrolled(body);
    const reopened = new Body(260);
    follow.opened(reopened);
    follow.scrolled(reopened);
    time.advance(1000);

    follow.gesture(reopened, "unknown");
    for (let i = 0; i < 5; i++) {
      time.advance(16);
      reopened.scrollTop -= 40;
      follow.scrolled(reopened);
    }
    expect(follow.pinned()).toBe(false);
    for (let i = 0; i < 5; i++) {
      time.advance(16);
      reopened.scrollTop += 40;
      follow.scrolled(reopened);
    }
    expect(distanceFromBottom(reopened)).toBeLessThan(1);
    expect(follow.pinned()).toBe(true);
  });

  it("a slow drag of the scrollbar thumb back to the edge re-arms even past the gesture window", () => {
    // A thumb drag sends a press and then only scroll events. Each of them is
    // the reader's and pushes the window on, or a drag longer than
    // READER_INTENT_WINDOW_MS would land at the bottom credited to the app.
    const { follow, body, time } = fresh(200);
    follow.gesture(body, "grab");
    for (let i = 0; i < 6; i++) {
      time.advance(50);
      body.scrollTop -= 50;
      follow.scrolled(body);
    }
    for (let i = 0; i < 20; i++) {
      time.advance(60);
      body.scrollTop += 15;
      follow.scrolled(body);
    }
    expect(20 * 60).toBeGreaterThan(READER_INTENT_WINDOW_MS);
    expect(distanceFromBottom(body)).toBeLessThan(1);
    expect(follow.pinned()).toBe(true);
  });
});

/**
 * The component's growth effect, played as it runs: on every change of the
 * text, of `open` or of `active`, it asks followsTheText, records whether the
 * block streamed, and hands an answered change to the follow.
 */
class TextEffect {
  private wasActive = false;

  constructor(
    private readonly follow: ReturnType<typeof thinkingFollow>,
    private readonly body: Body,
  ) {}

  /** One commit: `lines` new lines, the block streaming or not after it. */
  commit(lines: number, active: boolean, open = true): void {
    this.body.append(lines);
    const answered = followsTheText({ open, active, wasActive: this.wasActive });
    this.wasActive = active;
    if (answered) this.follow.grew(this.body);
  }
}

describe("the end of a block is followed like its middle", () => {
  it("the lines that arrive together with the end of the block are followed", () => {
    // Measured on the H3b build (wave-H3b/browser/400/400-end.json, 24 streams):
    // in the first frame after the block ended, the body stood 18.5 to 111.5 px
    // above its bottom in 16 streams, one to six lines. The last streaming
    // frame had stood at 0.5 px or less in 22 streams, at 37 and 37.5 px in
    // the other two.
    const { follow, body } = fresh();
    const effect = new TextEffect(follow, body);
    for (let i = 0; i < 180; i++) effect.commit(i % 2 === 0 ? 2 : 3, true);
    expect(distanceFromBottom(body)).toBeLessThan(1);
    effect.commit(4, false);
    const left = distanceFromBottom(body);
    expect(left, `the block ended ${left.toFixed(1)} px above its newest line`).toBeLessThan(1);
  });

  it("a change after the one that ended the block is not followed", () => {
    const { follow, body } = fresh();
    const effect = new TextEffect(follow, body);
    effect.commit(20, true);
    effect.commit(2, false);
    expect(distanceFromBottom(body)).toBeLessThan(1);
    effect.commit(3, false);
    expect(distanceFromBottom(body)).toBeCloseTo(3 * LINE_PX, 5);
  });

  it("a block that never streamed is not moved by its text", () => {
    // A settled block opens at the top for reading.
    const time = clock();
    const follow = thinkingFollow(time.now);
    const body = new Body(40);
    const effect = new TextEffect(follow, body);
    effect.commit(20, false);
    expect(body.scrollTop).toBe(0);
  });

  it("a closed block is not moved by the lines that end it", () => {
    const { follow, body } = fresh();
    const effect = new TextEffect(follow, body);
    effect.commit(20, true, false);
    effect.commit(4, false, false);
    expect(distanceFromBottom(body)).toBeCloseTo(24 * LINE_PX, 5);
  });

  it("a reader who scrolled away is not moved by the lines that end the block", () => {
    const { follow, body } = fresh(200);
    const effect = new TextEffect(follow, body);
    effect.commit(3, true);
    follow.gesture(body, wheelPull(-120));
    body.scrollTop -= 120;
    follow.scrolled(body);
    const held = body.scrollTop;
    effect.commit(3, true);
    effect.commit(4, false);
    expect(body.scrollTop).toBe(held);
  });
});

/**
 * A live stream at `linesPerSecond`, one commit per frame at 60 frames a
 * second. Each frame first delivers the scroll event the last jump queued,
 * then commits the lines that are due, and the growth effect jumps in the
 * commit (a layout effect).
 */
class LiveStream {
  private frame = 0;
  private produced = 0;
  private readonly effect: TextEffect;

  constructor(
    private readonly follow: ReturnType<typeof thinkingFollow>,
    private readonly body: Body,
    private readonly time: ReturnType<typeof clock>,
    private readonly linesPerSecond: number,
  ) {
    this.effect = new TextEffect(follow, body);
  }

  frames(n: number): void {
    for (let i = 0; i < n; i++) {
      this.frame++;
      this.time.advance(1000 / 60);
      if (this.body.scrollPending) {
        this.body.scrollPending = false;
        this.follow.scrolled(this.body);
      }
      const due = Math.floor((this.frame * this.linesPerSecond) / 60) - this.produced;
      if (due <= 0) continue;
      this.produced += due;
      this.effect.commit(due, true);
    }
  }
}

/** A reader's own scroll: the gesture, the box moving by `dy`, its scroll event. */
function readerScroll(
  follow: ReturnType<typeof thinkingFollow>,
  body: Body,
  pull: ReturnType<typeof wheelPull>,
  dy: number,
): void {
  follow.gesture(body, pull);
  body.scrollTop += dy;
  body.scrollPending = false;
  follow.scrolled(body);
}

describe("a reader who scrolls back to where they left gets the follow back", () => {
  it("wheel notches back down re-arm the follow although the stream outruns them", () => {
    // Measured on the H3b build (wave-H3b/browser/logs/c400-probe.log): at
    // 142 lines a second, one notch up, then 60 notches of 120 px down ended
    // 13,131 px above the bottom. The stream adds about 2,640 px a second,
    // the notches here about 1,800.
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(120);
    readerScroll(follow, body, wheelPull(-120), -120);
    expect(follow.pinned()).toBe(false);
    live.frames(150);
    const away = distanceFromBottom(body);
    expect(away).toBeGreaterThan(6000);

    let notches = 0;
    while (!follow.pinned() && notches < 60) {
      readerScroll(follow, body, wheelPull(120), 120);
      notches++;
      live.frames(4);
    }
    live.frames(30);
    const left = distanceFromBottom(body);
    expect(
      follow.pinned(),
      `after ${notches} notches the body stood ${left.toFixed(1)} px above its bottom`,
    ).toBe(true);
    expect(notches).toBe(1);
    expect(left).toBeLessThan(1);
  });

  it("a reader who went further up gets the follow back only where they left it", () => {
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    for (let i = 0; i < 5; i++) {
      readerScroll(follow, body, wheelPull(-120), -120);
      live.frames(4);
    }
    for (let i = 0; i < 4; i++) {
      readerScroll(follow, body, wheelPull(120), 120);
      live.frames(4);
    }
    // One notch above where they left: still reading, and new text leaves them.
    const held = body.scrollTop;
    live.frames(60);
    expect(follow.pinned()).toBe(false);
    expect(body.scrollTop).toBe(held);

    readerScroll(follow, body, wheelPull(120), 120);
    expect(follow.pinned()).toBe(true);
    live.frames(2);
    expect(distanceFromBottom(body)).toBeLessThan(1);
  });

  it("a scrolling key back to where the reader left re-arms", () => {
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    readerScroll(follow, body, keyPull("PageUp"), -CEILING_PX);
    live.frames(120);
    readerScroll(follow, body, keyPull("PageDown"), CEILING_PX);
    expect(follow.pinned()).toBe(true);
  });

  it("a touch drag back to where the reader left re-arms", () => {
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    readerScroll(follow, body, touchPull(60), -150);
    live.frames(120);
    readerScroll(follow, body, touchPull(-60), 150);
    expect(follow.pinned()).toBe(true);
  });

  it("where the reader left is where a drag heard only as a press began, not where it ended", () => {
    // An overlay scrollbar drag takes the follow off by the way the box moves
    // (the scroll-event path), after the box has already left.
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    readerScroll(follow, body, "unknown", -100);
    expect(follow.pinned()).toBe(false);
    live.frames(60);
    // 40 px back down stops 60 px short of where the drag began.
    readerScroll(follow, body, wheelPull(120), 40);
    expect(follow.pinned()).toBe(false);
    readerScroll(follow, body, wheelPull(120), 40);
    expect(follow.pinned()).toBe(true);
  });

  it("a drag of the scrollbar thumb back through where the reader left does not re-arm there", () => {
    // Deliberate: a thumb held under the pointer would pull the box back from
    // the jump on the next pointer move. The drag re-arms at the bottom edge,
    // as before (the slow thumb drag case above).
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    follow.gesture(body, "grab");
    for (let i = 0; i < 5; i++) {
      body.scrollTop -= 60;
      follow.scrolled(body);
      live.frames(1);
    }
    live.frames(60);
    // A second press on the thumb, then the drag back down, past the place
    // the reader left, with each move inside the gesture window.
    follow.gesture(body, "grab");
    for (let i = 0; i < 6; i++) {
      body.scrollTop += 60;
      follow.scrolled(body);
      live.frames(1);
    }
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    expect(follow.pinned()).toBe(false);
  });

  it("after the way back, a drag heard only as a press still takes the follow off", () => {
    // The press keeps the last pull, toward, and the body stands far below
    // the place the reader left earlier. Taking the follow off records where
    // the body stood before this drag, so that earlier place no longer counts.
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    readerScroll(follow, body, wheelPull(-120), -120);
    live.frames(60);
    readerScroll(follow, body, wheelPull(120), 120);
    live.frames(2);
    expect(follow.pinned()).toBe(true);
    expect(distanceFromBottom(body)).toBeLessThan(1);

    readerScroll(follow, body, "unknown", -100);
    expect(follow.pinned()).toBe(false);
  });

  it("a pull away is not undone by the way back in the same scroll event", () => {
    // The box can grow with no commit and so with no jump: a narrower window
    // wraps the same text into more rows. A press and a 20 px drag up then
    // stand more than 32 px above the bottom but within 32 px of where the
    // drag began. The way back applies only to a follow that was off before
    // this scroll event.
    const { follow, body } = fresh(200);
    follow.gesture(body, wheelPull(120));
    expect(follow.pinned()).toBe(true);
    body.append(3);
    readerScroll(follow, body, "unknown", -20);
    expect(distanceFromBottom(body)).toBeGreaterThan(THINKING_FOLLOW_PX);
    expect(follow.pinned()).toBe(false);
  });

  it("a scroll the reader did not cause does not re-arm at where they left", () => {
    const { follow, body, time } = fresh();
    const live = new LiveStream(follow, body, time, GLM_P90_LPS);
    live.frames(60);
    readerScroll(follow, body, wheelPull(-120), -120);
    readerScroll(follow, body, wheelPull(120), 40);
    expect(follow.pinned()).toBe(false);
    time.advance(READER_INTENT_WINDOW_MS);
    body.scrollTop += 80;
    follow.scrolled(body);
    expect(follow.pinned()).toBe(false);
  });
});

describe("a wheel the body cannot take belongs to the page", () => {
  it("a wheel up over a short body does not stop it following once it overflows", () => {
    // styles/scrollChaining.drift.test.ts: a bounded well hands the wheel to
    // the page when its content fits. The reader is scrolling the transcript.
    const { follow, body, time } = fresh(5);
    expect(body.scrollTop).toBe(0);
    follow.gesture(body, wheelPull(-120));
    expect(follow.pinned()).toBe(true);
    time.advance(50);
    body.append(40);
    follow.grew(body);
    expect(distanceFromBottom(body)).toBeLessThan(1);
  });
});

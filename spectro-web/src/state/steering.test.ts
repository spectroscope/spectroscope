import { describe, expect, it } from "vitest";
import { initialSteering, noteFrame, routeSubmit, type SteeringState } from "./steering";

/** Sends one sentence the way App does and returns the state after it. */
function sent(state: SteeringState, text: string): SteeringState {
  const routed = routeSubmit(state, text);
  if (routed.action !== "steer") throw new Error(`expected a steer, got ${routed.action}`);
  return routed.next;
}

const readBack = (text: string, taken: boolean, turn = 2) => ({
  type: "steering_message",
  agentId: "main",
  text,
  taken,
  turn,
  ts: 1,
});

describe("steering: what a submit does while a run is up (card 380)", () => {
  it("sends a steering frame, and the frame carries exactly the text", () => {
    const routed = routeSubmit(initialSteering, "use the cached list, not the API");

    expect(routed.action).toBe("steer");
    if (routed.action !== "steer") return;
    expect(routed.frame).toEqual({
      type: "steering_message",
      text: "use the cached list, not the API",
    });
  });

  it("queues instead when the message carries attachments", () => {
    // Owner call 2: text only. The composer's attachment path stores blobs
    // before a run starts and refuses the whole message when one is oversized;
    // a mid-run store is a second question with its own failure mode.
    const routed = routeSubmit(initialSteering, "look at this", [
      { name: "shot.png", mediaType: "image/png", dataBase64: "AA", sizeBytes: 2 },
    ]);

    expect(routed.action).toBe("queue");
  });

  it("drops blank at the edge, and a real sentence on the same path is not dropped", () => {
    // Paired: the negative alone is green on a router that drops everything.
    expect(routeSubmit(initialSteering, "   \n ").action).toBe("drop");
    expect(routeSubmit(initialSteering, "").action).toBe("drop");
    expect(routeSubmit(initialSteering, "real").action).toBe("steer");
  });

  it("queues every later submit once an older server refused the frame", () => {
    const first = sent(initialSteering, "first");

    const refused = noteFrame(first, { type: "error", message: "Unknown message type." });
    expect(refused.next.understood).toBe(false);
    expect(refused.requeue).toEqual(["first"]);
    expect(refused.next.pending).toEqual([]);

    expect(routeSubmit(refused.next, "second").action).toBe("queue");
    expect(routeSubmit(refused.next, "third").action).toBe("queue");
  });

  it("gives each refused frame back once, in the order it was sent", () => {
    // Two frames can leave before the first refusal comes back. The error
    // frame names no message, so the page pairs refusals with its own list,
    // oldest first, which is the order the server answered in.
    const two = sent(sent(initialSteering, "first"), "second");

    const one = noteFrame(two, { type: "error", message: "Unknown message type." });
    const both = noteFrame(one.next, { type: "error", message: "Unknown message type." });

    expect(one.requeue).toEqual(["first"]);
    expect(both.requeue).toEqual(["second"]);
    expect(both.next.pending).toEqual([]);
  });

  it("treats that error as the agent's own when no steering frame is outstanding", () => {
    // The same text with nothing asked is a real failure and belongs on the
    // operator's screen. The transport draws this line for its liveness probe
    // and the steering path needs its own flag of the same shape.
    const quiet = noteFrame(initialSteering, { type: "error", message: "Unknown message type." });

    expect(quiet.next.understood).toBe(true);
    expect(quiet.requeue).toEqual([]);
  });

  it("leaves an unrelated error alone", () => {
    const first = sent(initialSteering, "first");

    const other = noteFrame(first, { type: "error", message: "the provider timed out" });

    expect(other.next.understood).toBe(true);
    expect(other.next.pending.map((p) => p.text)).toEqual(["first"]);
    expect(other.requeue).toEqual([]);
  });
});

// Fix round 2026-09-24, item 2: the sentence is visible from the moment it is
// sent. Until the run reads it, it is a pending row the page draws itself; the
// run's own steering_message line then says what became of it.
describe("steering: the sentence stays visible until the run answers for it", () => {
  it("is pending the moment it is sent, with the text the operator typed", () => {
    const state = sent(initialSteering, "  use the cached list  ");

    expect(state.pending.map((p) => p.text)).toEqual(["use the cached list"]);
  });

  it("leaves the pending rows when the run says it read it, and nothing goes back", () => {
    const state = sent(initialSteering, "use the cached list");

    const read = noteFrame(state, readBack("use the cached list", true));

    expect(read.next.pending).toEqual([]);
    expect(read.requeue).toEqual([]);
    // And a refusal arriving afterwards is nobody's steering frame any more.
    const later = noteFrame(read.next, { type: "error", message: "Unknown message type." });
    expect(later.next.understood).toBe(true);
    expect(later.requeue).toEqual([]);
  });

  it("goes back to the waiting line when the run ended before reading it", () => {
    // Owner call 3, as the card words it: the message falls back to exactly
    // today's behaviour and starts the next run. The old waiting line is what
    // does that, so the text goes back into it, untouched.
    const state = sent(initialSteering, "use the cached list");

    const missed = noteFrame(state, readBack("use the cached list", false, 0));

    expect(missed.next.pending).toEqual([]);
    expect(missed.requeue).toEqual(["use the cached list"]);
  });

  it("matches a folded line to exactly the sentences it folded, in order", () => {
    // The loop folds everything waiting into one text joined by a newline. A
    // third sentence sent after that fold is still pending, and must stay so.
    const state = sent(sent(sent(initialSteering, "first"), "second"), "third");

    const missed = noteFrame(state, readBack("first\nsecond", false));

    expect(missed.requeue).toEqual(["first", "second"]);
    expect(missed.next.pending.map((p) => p.text)).toEqual(["third"]);
  });

  it("gives nothing back for a line it did not send, such as a replayed session", () => {
    // A resumed session replays its record, and a not-taken line from an
    // evening ago must not resend itself. Only the page's own pending
    // sentences go back into the waiting line.
    const replay = noteFrame(initialSteering, readBack("from last night", false));

    expect(replay.requeue).toEqual([]);
    expect(replay.next.pending).toEqual([]);

    // And with a sentence of this page's own still pending, a line that is not
    // about it leaves it alone: it stays pending and nothing goes back. With
    // nothing pending the case above is green on a function that hands back
    // everything it holds.
    const busy = noteFrame(sent(initialSteering, "typed just now"), readBack("from last night", false));
    expect(busy.requeue).toEqual([]);
    expect(busy.next.pending.map((p) => p.text)).toEqual(["typed just now"]);

    // The positive twin on the same function: a sentence this page did send
    // does go back, so the negative is not green on a function that never
    // gives anything back.
    const own = noteFrame(sent(initialSteering, "from last night"), readBack("from last night", false));
    expect(own.requeue).toEqual(["from last night"]);
  });
});

// Review of the fix round 2026-09-24: the page and the server must end up with
// the same text for one sentence, or the pending row never finds its line.
// Java's strip() and JS's trim() disagree on seven characters (measured over
// U+0000..U+FFFF, JDK 21 and node): Java keeps U+00A0, U+2007, U+202F and
// U+FEFF, JS keeps U+001C..U+001F.

/** Character.isWhitespace as the JDK javadoc defines it: space separators
 *  except the three no-break ones, the line and paragraph separators, and nine
 *  controls. Written from that definition, not from the page's rule, so the
 *  two can disagree. String.strip() removes exactly these at both ends. */
function isJavaWhitespace(ch: string): boolean {
  if (/\p{Zs}/u.test(ch)) return ![" ", " ", " "].includes(ch);
  if (/[\p{Zl}\p{Zp}]/u.test(ch)) return true;
  return ["\t", "\n", "\u000b", "\f", "\r", "\u001c", "\u001d", "\u001e", "\u001f"].includes(ch);
}

/** What SteeringInbox.submit keeps of a frame's text, and so what the run's
 *  steering_message line carries back. */
function javaStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isJavaWhitespace(text[start])) start++;
  while (end > start && isJavaWhitespace(text[end - 1])) end--;
  return text.slice(start, end);
}

/** Sends one sentence the way App does and returns the state plus the frame's text. */
function steered(state: SteeringState, text: string): { next: SteeringState; frameText: string } {
  const routed = routeSubmit(state, text);
  if (routed.action !== "steer") throw new Error(`expected a steer, got ${routed.action}`);
  if (routed.frame.type !== "steering_message") throw new Error("expected a steering frame");
  return { next: routed.next, frameText: routed.frame.text };
}

describe("steering: the page and the server agree on the sentence", () => {
  it("matches its own line when the sentence ends in a no-break space, and so does the next one", () => {
    // Option+Space on a German Mac keyboard types U+00A0. The server kept it
    // and the page did not, so the row never matched, and every later row
    // waited behind it for as long as the socket lived.
    const first = steered(initialSteering, "stop using the API ");
    const read = noteFrame(first.next, readBack(javaStrip(first.frameText), true));
    expect(read.next.pending).toEqual([]);

    const second = steered(read.next, "and check the cache");
    const missed = noteFrame(second.next, readBack(javaStrip(second.frameText), false));
    expect(missed.next.pending).toEqual([]);
    expect(missed.requeue).toEqual(["and check the cache"]);
  });

  it("hands the server a sentence it has nothing left to strip, for every character at either end", () => {
    const disagree: string[] = [];
    let checked = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      for (const text of [`stop${ch}`, `${ch}stop`]) {
        const { next, frameText } = steered(initialSteering, text);
        checked++;
        if (javaStrip(frameText) !== frameText || next.pending[0].text !== frameText) {
          disagree.push(cp.toString(16).padStart(4, "0"));
        }
      }
    }
    expect(disagree).toEqual([]);
    expect(checked).toBe(2 * (0x10000 - 0x800));
  });

  it("drops every sentence the server would call blank", () => {
    // SteeringInbox answers a blank submit with nothing at all, so a row the
    // page kept for it would wait forever.
    const kept: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      if (isJavaWhitespace(ch) && routeSubmit(initialSteering, `${ch}${ch}`).action !== "drop") {
        kept.push(cp.toString(16).padStart(4, "0"));
      }
    }
    expect(kept).toEqual([]);
    // The positive twin: a sentence with a visible character still goes out.
    expect(routeSubmit(initialSteering, "\u001fgo\u001f").action).toBe("steer");
  });
});

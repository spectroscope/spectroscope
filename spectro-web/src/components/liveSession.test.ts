import { describe, expect, it } from "vitest";
import { LIVE_START, heardText, liveStep, type LiveText } from "./liveSession";

/** Run a whole conversation through the reducer. */
function play(...frames: unknown[]): LiveText {
  return frames.reduce<LiveText>((state, frame) => liveStep(state, frame), LIVE_START);
}

describe("what the live frames mean for the composer", () => {
  it("grows the provisional text as the words arrive", () => {
    const state = play(
      { type: "ready" },
      { type: "partial", text: " This" },
      { type: "partial", text: " is" },
      { type: "partial", text: " live" },
    );
    expect(state.ready).toBe(true);
    expect(state.provisional).toBe("This is live");
    expect(state.committed).toBeNull();
  });

  it("does not leak the first delta's leading space into the composer", () => {
    // Every delta arrives space-prefixed because it is a word in a sentence.
    // The first one is not.
    expect(play({ type: "partial", text: " Hello" }).provisional).toBe("Hello");
  });

  it("REPLACES the provisional text with the final, never appends it", () => {
    // The measured session happened to end with a transcript equal to the
    // concatenated deltas. That is not promised: the model is free to correct
    // punctuation, casing or a whole word once it has heard the end. Appending
    // would produce the sentence twice, and trusting the concatenation would
    // publish a guess as the answer.
    const state = play({ type: "partial", text: " hello there" }, { type: "final", text: "Hello there." });
    expect(state.committed).toBe("Hello there.");
    expect(state.provisional).toBe("");
  });

  it("names a refusal by its reason so the sentence can be the right one", () => {
    expect(play({ type: "error", reason: "localRoute" }).failed).toBe("localRoute");
    expect(play({ type: "error", reason: "noKey" }).failed).toBe("noKey");
    expect(play({ type: "error", reason: "upstream", text: "rate limit" }).failed).toBe("upstream");
  });

  it("keeps what was heard on a failure but never commits it", () => {
    // The faded text is what the microphone picked up and it is worth seeing.
    // What must not happen is that a guess quietly becomes the transcript
    // because the session died before it could be corrected.
    const state = play(
      { type: "partial", text: " half a sentence" },
      { type: "error", reason: "upstream", text: "rate limit reached" },
    );
    expect(state.provisional).toBe("half a sentence");
    expect(state.committed).toBeNull();
    expect(state.failed).toBe("upstream");
  });

  it("ignores anything that arrives after a failure", () => {
    // A session that refused cannot then answer. Accepting text after a
    // refusal would put words in the composer that nothing explains.
    const state = play(
      { type: "error", reason: "upstream" },
      { type: "partial", text: " more" },
      { type: "final", text: "a transcript out of nowhere" },
    );
    expect(state.committed).toBeNull();
    expect(state.provisional).toBe("");
  });

  it("treats a close before the transcript as a failure, and after it as normal", () => {
    expect(play({ type: "partial", text: " cut off" }, { type: "closed" }).failed).toBe("closed");
    const finished = play({ type: "final", text: "All done." }, { type: "closed" });
    expect(finished.failed).toBeNull();
    expect(finished.committed).toBe("All done.");
  });

  it("is unmoved by frames it does not know, including rubbish", () => {
    // The socket also carries `wire`, and the server is free to add events this
    // build has never seen. A reducer that corrupts its state on an unknown
    // frame loses the recording that was going fine.
    const before = play({ type: "partial", text: " steady" });
    for (const junk of [
      { type: "wire", xid: "x1" },
      { type: "somethingNew" },
      { nope: true },
      null,
      "not an object",
      42,
    ]) {
      expect(liveStep(before, junk)).toEqual(before);
    }
  });

  it("ignores a partial with no text rather than appending undefined", () => {
    const before = play({ type: "partial", text: " steady" });
    expect(liveStep(before, { type: "partial" })).toEqual(before);
    expect(liveStep(before, { type: "partial", text: "" })).toEqual(before);
  });
});

describe("the local route's frames (card 527)", () => {
  it("REPLACES the provisional text on a partial that says replace", () => {
    // A local run covers the whole open window, so its answer is the window's
    // text so far. Appending would print the window twice.
    const state = play(
      { type: "partial", text: "hello", replace: true },
      { type: "partial", text: "hello there", replace: true },
    );
    expect(state.provisional).toBe("hello there");
  });

  it("still appends a partial without replace, as the hosted route sends them", () => {
    const state = play({ type: "partial", text: " hello" }, { type: "partial", text: " there" });
    expect(state.provisional).toBe("hello there");
  });

  it("keeps a closed window's text and carries on with the next window", () => {
    const state = play(
      { type: "partial", text: "Good morning", replace: true },
      { type: "final", text: "Good morning.", more: true },
      { type: "partial", text: "Please open", replace: true },
    );
    expect(state.committed).toBeNull();
    expect(state.settled).toBe("Good morning.");
    expect(state.provisional).toBe("Please open");
    expect(heardText(state)).toBe("Good morning. Please open");
  });

  it("commits every window together on the last final", () => {
    const state = play(
      { type: "final", text: "Good morning.", more: true },
      { type: "partial", text: "Please open", replace: true },
      { type: "final", text: "Please open the settings." },
    );
    expect(state.committed).toBe("Good morning. Please open the settings.");
    expect(state.provisional).toBe("");
    expect(state.settled).toBe("");
  });

  it("remembers how long the last whisper run took", () => {
    const state = play({ type: "partial", text: "hello", replace: true, durationMs: 812 });
    expect(state.runMs).toBe(812);
  });

  it("an empty replacing partial clears what the window showed", () => {
    const state = play(
      { type: "partial", text: "uh", replace: true },
      { type: "partial", text: "", replace: true },
    );
    expect(state.provisional).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { PCM_TAP_SOURCE, liveSocketUrl } from "./liveCapture";
import { appendFrames } from "./pcmChunks";
import { LIVE_RATE } from "./liveTranscription";

describe("where the live socket connects", () => {
  it("follows the page's own origin rather than a guessed host", () => {
    // The server is reached at whatever origin the page was served from — the
    // desktop shell picks a port at runtime (card 168), the dev server is 5173
    // against a proxy, and a hardcoded localhost:8080 works on exactly one of
    // those.
    expect(liveSocketUrl("http://localhost:8080")).toBe("ws://localhost:8080/ws/stt");
    expect(liveSocketUrl("http://localhost:63171")).toBe("ws://localhost:63171/ws/stt");
  });

  it("upgrades to wss when the page is https", () => {
    // A ws:// socket from an https page is blocked as mixed content, and the
    // failure looks like the server being down.
    expect(liveSocketUrl("https://app.example.com")).toBe("wss://app.example.com/ws/stt");
  });

  it("does not turn an http origin into wss by accident", () => {
    // The naive replace is origin.replace("http", "ws"), which is right, and
    // origin.replace(/http/, "wss") which is not. Pinned because both read the
    // same at a glance.
    expect(liveSocketUrl("http://localhost:1234").startsWith("ws://")).toBe(true);
  });
});

describe("the tap that hands the microphone over in pieces", () => {
  it("batches to one append rather than posting every render quantum", () => {
    // A worklet's process() runs every 128 frames, which is about 5 ms at the
    // live rate — roughly 190 messages a second, each one a socket frame and a
    // base64 pass. The tap accumulates an append's worth first.
    expect(PCM_TAP_SOURCE).toContain("chunk");
    expect(appendFrames(LIVE_RATE)).toBe(4800);
  });

  it("copies the frame it hands over", () => {
    // Web Audio reuses the input buffer between calls. Posting it without a
    // copy hands over memory that is overwritten before it is read, which
    // sounds like a recording of the last 5 ms repeated forever.
    expect(PCM_TAP_SOURCE).toContain("slice()");
  });

  it("registers under the name the capture chain asks for", () => {
    expect(PCM_TAP_SOURCE).toContain('registerProcessor("pcm-tap"');
  });
});

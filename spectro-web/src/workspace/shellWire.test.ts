import { describe, it, expect } from "vitest";
import {
  SHELL_MAX_DATA,
  encodeKeys,
  encodeKeyBytes,
  encodeResize,
  decodeStatus,
  shellSocketUrl,
} from "./shellWire";

describe("encodeKeys", () => {
  it("prefixes the data opcode", () => {
    expect(Array.from(encodeKeys("a")[0])).toEqual([0x00, 0x61]);
  });

  it("carries a control byte through untouched", () => {
    // Ctrl-C is the whole point of the up channel: the server proved it yields 130.
    expect(Array.from(encodeKeys("")[0])).toEqual([0x00, 0x03]);
  });

  it("encodes non-ascii as utf-8", () => {
    expect(Array.from(encodeKeys("ä")[0])).toEqual([0x00, 0xc3, 0xa4]);
  });

  it("sends one frame for an ordinary keystroke", () => {
    expect(encodeKeys("ls\r")).toHaveLength(1);
  });

  it("splits a paste that would exceed the server's frame cap", () => {
    const frames = encodeKeys("x".repeat(SHELL_MAX_DATA + 10));
    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(SHELL_MAX_DATA + 1);
    expect(frames[1].length).toBe(11);
    expect(frames[1][0]).toBe(0x00);
  });

  it("sends nothing for an empty string", () => {
    expect(encodeKeys("")).toEqual([]);
  });
});

describe("encodeResize", () => {
  it("writes rows then cols as big-endian u16", () => {
    expect(Array.from(encodeResize(24, 80))).toEqual([0x01, 0x00, 0x18, 0x00, 0x50]);
  });

  it("uses both bytes above 255", () => {
    expect(Array.from(encodeResize(300, 500))).toEqual([0x01, 0x01, 0x2c, 0x01, 0xf4]);
  });

  it("clamps to the range the server clamps to", () => {
    expect(Array.from(encodeResize(0, 0))).toEqual([0x01, 0x00, 0x01, 0x00, 0x01]);
    expect(Array.from(encodeResize(5000, 5000))).toEqual([0x01, 0x03, 0xe8, 0x03, 0xe8]);
  });

  it("rounds a fractional measurement rather than truncating the frame", () => {
    expect(Array.from(encodeResize(23.6, 79.2))).toEqual([0x01, 0x00, 0x18, 0x00, 0x4f]);
  });
});

describe("decodeStatus", () => {
  it("reads the ready notice", () => {
    const status = decodeStatus(
      JSON.stringify({
        type: "shell_ready",
        cwd: "/tmp/ws",
        shell: "/bin/zsh",
        rows: 24,
        cols: 80,
        note: "this shell runs with your own privileges",
      }),
    );
    expect(status).toEqual({
      type: "shell_ready",
      cwd: "/tmp/ws",
      shell: "/bin/zsh",
      rows: 24,
      cols: 80,
      note: "this shell runs with your own privileges",
    });
  });

  it("reads the exit notice", () => {
    expect(decodeStatus('{"type":"shell_exit","code":130}')).toEqual({
      type: "shell_exit",
      code: 130,
    });
  });

  it("reads the server's error fallback", () => {
    expect(decodeStatus('{"type":"shell_error"}')).toEqual({ type: "shell_error" });
  });

  it("returns null for junk instead of throwing", () => {
    expect(decodeStatus("not json")).toBeNull();
    expect(decodeStatus("[]")).toBeNull();
    expect(decodeStatus('{"type":"something_else"}')).toBeNull();
  });
});

describe("shellSocketUrl", () => {
  it("builds the endpoint from the page origin", () => {
    expect(shellSocketUrl("s1", 24, 80, { protocol: "http:", host: "localhost:8080" })).toBe(
      "ws://localhost:8080/ws/shell?session=s1&rows=24&cols=80",
    );
  });

  it("upgrades to wss on a secure page", () => {
    expect(shellSocketUrl("s1", 24, 80, { protocol: "https:", host: "localhost:8443" })).toBe(
      "wss://localhost:8443/ws/shell?session=s1&rows=24&cols=80",
    );
  });

  it("escapes a session id rather than pasting it into the query", () => {
    expect(shellSocketUrl("a&b=c", 24, 80, { protocol: "http:", host: "h" })).toBe(
      "ws://h/ws/shell?session=a%26b%3Dc&rows=24&cols=80",
    );
  });

  it("omits the session when there is none, so the server refuses cleanly", () => {
    expect(shellSocketUrl(undefined, 24, 80, { protocol: "http:", host: "h" })).toBe(
      "ws://h/ws/shell?rows=24&cols=80",
    );
  });
});

describe("encodeKeyBytes", () => {
  it("frames bytes that are already bytes, without a utf-8 pass", () => {
    // xterm's onBinary hands over 8-bit values one per char; running those
    // through the text encoder would turn 0x80 into two bytes.
    expect(Array.from(encodeKeyBytes(Uint8Array.from([0x80, 0xff]))[0])).toEqual([0x00, 0x80, 0xff]);
  });

  it("splits at the same cap as a keystroke frame", () => {
    const frames = encodeKeyBytes(new Uint8Array(SHELL_MAX_DATA + 1));
    expect(frames).toHaveLength(2);
    expect(frames[1].length).toBe(2);
  });

  it("sends nothing for an empty buffer", () => {
    expect(encodeKeyBytes(new Uint8Array(0))).toEqual([]);
  });
});

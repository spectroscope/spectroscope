// Release 0.14.2, live check D1, the page's half. A stored session opened
// after a reload is read from its record until the first message continues
// it. The header chip named the record's provider beside the model the
// window saved last (ollama plus glm-5.3:cloud for a session that ran on
// qwen2.5:3b), and a continued session showed that saved model until its
// socket answered. The chip now names one pair, from one source.

import { describe, expect, it } from "vitest";
import { headerBackend } from "./headerBackend";

const saved = { provider: "ollama", model: "glm-5.3:cloud" };
const recorded = { provider: "ollama", model: "qwen2.5:3b" };

describe("headerBackend: the pair the header chip names", () => {
  it("a stored session read from its record names the pair it ran on, not the saved default", () => {
    expect(headerBackend({ viewingLive: false, recorded, wire: saved, boot: saved })).toEqual(recorded);
  });

  it("a record without a model names no model rather than another session's", () => {
    expect(
      headerBackend({
        viewingLive: false,
        recorded: { provider: "ollama", model: null },
        wire: saved,
        boot: saved,
      }),
    ).toEqual({
      provider: "ollama",
      model: undefined,
    });
  });

  it("a continued session names its recorded pair until the server's frame arrives", () => {
    expect(headerBackend({ viewingLive: true, recorded, wire: null, boot: saved })).toEqual(recorded);
  });

  it("the server's frame is wire truth once it arrives, even when it names another pair", () => {
    // The server falls back when the recorded provider cannot run any more;
    // the frame says which pair runs, and the chip follows it.
    expect(headerBackend({ viewingLive: true, recorded, wire: saved, boot: saved })).toEqual(saved);
  });

  it("a fresh chat with no frame yet names the boot config", () => {
    expect(
      headerBackend({
        viewingLive: true,
        recorded: { provider: null, model: null },
        wire: null,
        boot: saved,
      }),
    ).toEqual(saved);
    expect(
      headerBackend({ viewingLive: true, recorded: { provider: null, model: null }, wire: null, boot: null }),
    ).toEqual({
      provider: undefined,
      model: undefined,
    });
  });
});

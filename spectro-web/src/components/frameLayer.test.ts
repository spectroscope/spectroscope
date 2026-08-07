// Which wire a row actually rode (card 184, owner 2026-08-07: "können wir hier
// noch ein wenig ehrlicher sein … weil am Ende ist doch NUR der llm_exchange an
// anthropic gegangen?").
//
// He is right, and the columns had it exactly backwards. In a one-turn session
// nine rows carried `SSE` and `api.anthropic.com` while riding nothing but the
// WebSocket from localhost, and the ONE row that really was an HTTPS call to
// api.anthropic.com carried "·" and two dashes.
//
// The cause is that `llmDirection` is an INTERPRETATION — "this frame is part of
// what was handed to the model" — sitting in a column next to PROTO and HOST,
// which are network FACTS. An interpretation that looks like a measurement is
// the one thing this app must not print. The layer is what separates them: the
// columns describe the row's own wire, and the reading stays available as the
// filter it always was.

import { describe, expect, it } from "vitest";
import { frameLayer } from "./frameLayer";

describe("the layer a frame belongs to", () => {
  it("puts the recorded exchange on the llm layer — the only one that leaves this machine for a model", () => {
    expect(frameLayer("llm_exchange")).toBe("llm");
    expect(frameLayer("llm_request")).toBe("llm");
    expect(frameLayer("llm_response")).toBe("llm");
  });

  it("puts every session frame on the app layer, whatever it says ABOUT the model", () => {
    for (const type of ["run_start", "turn_start", "text_delta", "thinking_delta", "usage", "run_end"]) {
      expect(frameLayer(type)).toBe("app");
    }
  });

  it("puts a tool call on its own layer: the frame rode the socket, the WORK did not", () => {
    expect(frameLayer("tool_call")).toBe("tool");
    expect(frameLayer("tool_result")).toBe("tool");
  });

  it("files a type it has never heard of as app rather than guessing it left the machine", () => {
    expect(frameLayer("something_new")).toBe("app");
  });
});

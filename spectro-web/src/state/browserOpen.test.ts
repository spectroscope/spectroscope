// Card 472: the "Graph ready" chip asks the internal browser of a session to
// open its code graph. The browser segment owns the view socket, so the ask
// waits in this store until the segment of THAT session takes it, once, and
// sends the open_code_graph frame. The page never builds the address: the
// server mints a one-shot ticket and navigates on its own port.

import { describe, expect, it } from "vitest";
import { openCodeGraphFrame } from "../browser/liveView";
import { browserOpenSeq, requestCodeGraphOpen, takeCodeGraphOpen } from "./browserOpen";

describe("a request to open the code graph in the internal browser", () => {
  it("is taken once, by the segment of its own session", () => {
    const before = browserOpenSeq();
    requestCodeGraphOpen("s-1");

    expect(browserOpenSeq()).toBe(before + 1);
    expect(takeCodeGraphOpen("s-2")).toBe(false);
    expect(takeCodeGraphOpen("s-1")).toBe(true);
    expect(takeCodeGraphOpen("s-1")).toBe(false);
  });

  it("keeps only the latest ask", () => {
    requestCodeGraphOpen("s-1");
    requestCodeGraphOpen("s-2");
    expect(takeCodeGraphOpen("s-1")).toBe(false);
    expect(takeCodeGraphOpen("s-2")).toBe(true);
  });

  it("travels as its own frame that names the session and no address", () => {
    expect(openCodeGraphFrame("s-1")).toEqual({ type: "open_code_graph", sessionId: "s-1" });
  });
});

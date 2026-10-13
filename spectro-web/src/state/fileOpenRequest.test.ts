// Card 586: a press on a run's document or file asks the Files panel to open it.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetFileOpenRequestForTests,
  currentFileOpenRequest,
  takeFileOpenRequest,
  requestOpenFile,
  subscribeFileOpenRequest,
} from "./fileOpenRequest";
import { runDocumentUrl } from "../workspace/preview";

beforeEach(() => __resetFileOpenRequestForTests());

describe("the file open request (card 586)", () => {
  it("is null until a request is made", () => {
    expect(currentFileOpenRequest()).toBeNull();
  });

  it("tells a subscriber about a request with its path, its url and a seq that grows", () => {
    const seen: unknown[] = [];
    const stop = subscribeFileOpenRequest(() => seen.push(currentFileOpenRequest()));
    requestOpenFile("docs/plan.md");
    requestOpenFile(".superpowers/spec.md", "/api/run-document?session=s&run=abcdefabcdef&path=x", "s");
    stop();
    expect(seen).toEqual([
      { path: "docs/plan.md", session: null, seq: 1 },
      {
        path: ".superpowers/spec.md",
        url: "/api/run-document?session=s&run=abcdefabcdef&path=x",
        session: "s",
        seq: 2,
      },
    ]);
    expect(Object.keys(seen[0] as object), "no url key without a url").not.toContain("url");
  });

  it("gives the same path twice two seq values", () => {
    requestOpenFile("docs/plan.md");
    requestOpenFile("docs/plan.md");
    expect(currentFileOpenRequest()?.seq).toBe(2);
  });

  it("is taken once per request, so a pane that mounts later opens it and a remount does not again", () => {
    requestOpenFile("docs/plan.md", undefined, "s-1");
    const seq = currentFileOpenRequest()?.seq ?? -1;
    expect(takeFileOpenRequest(seq, "s-1")).toBe(true);
    expect(takeFileOpenRequest(seq, "s-1")).toBe(false);
    requestOpenFile("docs/plan.md", undefined, "s-1");
    expect(takeFileOpenRequest(seq + 1, "s-1")).toBe(true);
  });

  // Final fix round: a request belongs to the session whose Files panel it was
  // made for. Another session's panel drops it, and it is not opened later.
  it("is dropped by another session's panel and not opened by its own afterwards", () => {
    requestOpenFile(".superpowers/spec.md", "/api/run-document?x", "s-1");
    const seq = currentFileOpenRequest()?.seq ?? -1;
    expect(takeFileOpenRequest(seq, "s-2")).toBe(false);
    expect(takeFileOpenRequest(seq, "s-1")).toBe(false);
  });

  it("a request without a session is opened by a panel without one, and not by a session's", () => {
    requestOpenFile("docs/plan.md");
    expect(takeFileOpenRequest(currentFileOpenRequest()?.seq ?? -1, null)).toBe(true);
    requestOpenFile("docs/plan.md");
    expect(takeFileOpenRequest(currentFileOpenRequest()?.seq ?? -1, "s-1")).toBe(false);
  });
});

describe("runDocumentUrl (card 586)", () => {
  it("names the session, the run and the path, each encoded", () => {
    expect(runDocumentUrl("s-1", "abcdefabcdef", "docs/Plan für Frogger.md")).toBe(
      "/api/run-document?session=s-1&run=abcdefabcdef&path=docs%2FPlan%20f%C3%BCr%20Frogger.md",
    );
    expect(runDocumentUrl("a&b", "abcdefabcdef", ".superpowers/a?b.md")).toBe(
      "/api/run-document?session=a%26b&run=abcdefabcdef&path=.superpowers%2Fa%3Fb.md",
    );
  });
});

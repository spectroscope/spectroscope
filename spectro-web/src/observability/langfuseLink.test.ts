// The session to trace deep link (card 137).
//
// The pinned id below is the SAME literal as OtlpTraceIdPinTest.PINNED on the
// Java side, and it was measured against a live Langfuse instance. If either
// side ever changes how a trace is seeded, both suites go red together, which
// is the only way this link stays honest.

import { describe, expect, it } from "vitest";
import { langfuseTraceId, langfuseTraceUrl, traceLinkFor } from "./langfuseLink";

const SESSION = "20260726-172215";
const PINNED = "029564610f262b63fd5b47c64f54cda7";

describe("langfuseTraceId", () => {
  it("the trace id matches the java sink", () => {
    expect(langfuseTraceId(SESSION)).toBe(PINNED);
  });
});

describe("langfuseTraceUrl", () => {
  it("builds the trace url from the otlp endpoint", () => {
    expect(langfuseTraceUrl("http://localhost:3000/api/public/otel", SESSION)).toBe(
      `http://localhost:3000/trace/${PINNED}`,
    );
  });

  it("accepts the v1/traces form", () => {
    expect(langfuseTraceUrl("http://localhost:3000/api/public/otel/v1/traces", SESSION)).toBe(
      `http://localhost:3000/trace/${PINNED}`,
    );
  });

  it("accepts a trailing slash", () => {
    expect(langfuseTraceUrl("http://localhost:3000/api/public/otel/", SESSION)).toBe(
      `http://localhost:3000/trace/${PINNED}`,
    );
  });

  it("works for langfuse cloud", () => {
    expect(langfuseTraceUrl("https://cloud.langfuse.com/api/public/otel", SESSION)).toBe(
      `https://cloud.langfuse.com/trace/${PINNED}`,
    );
  });

  it("keeps a non-default port", () => {
    expect(langfuseTraceUrl("http://localhost:3100/api/public/otel", SESSION)).toBe(
      `http://localhost:3100/trace/${PINNED}`,
    );
  });

  it("returns null for a jaeger endpoint", () => {
    // The guard that keeps a dead link off a non-Langfuse install: Jaeger
    // exports perfectly well and has no /trace/<id> page of this shape.
    expect(langfuseTraceUrl("http://localhost:4318/v1/traces", SESSION)).toBeNull();
  });

  it("returns null for null, empty and junk", () => {
    expect(langfuseTraceUrl(null, SESSION)).toBeNull();
    expect(langfuseTraceUrl(undefined, SESSION)).toBeNull();
    expect(langfuseTraceUrl("", SESSION)).toBeNull();
    expect(langfuseTraceUrl("not a url", SESSION)).toBeNull();
    expect(() => langfuseTraceUrl("http://[", SESSION)).not.toThrow();
    expect(langfuseTraceUrl("http://[", SESSION)).toBeNull();
  });

  it("returns null without a session id", () => {
    expect(langfuseTraceUrl("http://localhost:3000/api/public/otel", "")).toBeNull();
  });
});

describe("traceLinkFor", () => {
  const live = {
    live: true,
    inFleet: false,
    sessionId: SESSION,
    endpoint: "http://localhost:3000/api/public/otel",
  };

  it("links the live session's own landed export", () => {
    expect(traceLinkFor(live)).toBe(`http://localhost:3000/trace/${PINNED}`);
  });

  it("offers nothing while a fleet is entered", () => {
    // The trace tab shows the MEMBER's wire on a drill-in, and that member
    // exports under its own session id from its own process. Linking here would
    // open a trace holding none of the rows on screen.
    expect(traceLinkFor({ ...live, inFleet: true })).toBeNull();
  });

  it("offers nothing for anything that is not the live wire", () => {
    // An imported file can carry a forged otlp_export line, and the fold
    // believes it: the endpoint would be attacker chosen and the app's own
    // toolbar would offer a one-click trip to it. A recorded archive never
    // carries the frame at all, so this costs nothing that used to work.
    expect(
      traceLinkFor({ ...live, live: false, endpoint: "https://langfuse-login.evil.example/api/public/otel" }),
    ).toBeNull();
    expect(traceLinkFor({ ...live, live: false })).toBeNull();
  });

  it("offers nothing without a session id or a landed export", () => {
    expect(traceLinkFor({ ...live, sessionId: null })).toBeNull();
    expect(traceLinkFor({ ...live, endpoint: null })).toBeNull();
  });

  it("still refuses a backend that is not langfuse shaped", () => {
    expect(traceLinkFor({ ...live, endpoint: "http://localhost:4318/v1/traces" })).toBeNull();
  });
});

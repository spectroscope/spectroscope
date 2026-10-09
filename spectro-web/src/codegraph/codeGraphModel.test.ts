// Card 472 (owner, 2026-10-09): "Build code graph" runs graphify in the
// background of the harness; the header shows the build while it runs and a
// "Graph ready" chip when it ends, and the chip opens graph.html in the
// internal browser. These tests hold the pure half: what the header shows for
// each state, what the sheet offers first, and what goes over the wire.

import { describe, expect, it } from "vitest";
import {
  codeGraphDoctorRow,
  defaultMode,
  failureLines,
  fetchCodeGraphStatus,
  headerView,
  pollDelay,
  POLL_MS,
  postCodeGraphStart,
  shortTime,
  startBody,
  codeGraphSessionOf,
  type CodeGraphJob,
  type CodeGraphStatus,
} from "./codeGraphModel";

const JOB: CodeGraphJob = {
  folder: "/work/project",
  sessionId: "s-1",
  mode: "full",
  state: "running",
  startedAt: "2026-10-09T10:00:00Z",
  endedAt: null,
  exitCode: null,
  lastLine: "[graphify extract] AST extraction on 2 code files...",
  tail: ["[graphify extract] scanning", "[graphify extract] AST extraction on 2 code files..."],
};

const BASE: CodeGraphStatus = {
  installed: true,
  binary: "/opt/tools/graphify",
  searched: ["/opt/homebrew/bin", "/usr/bin"],
  install: "uv tool install graphifyy",
  folder: "/work/project",
  graph: { exists: false, modifiedAt: null },
  job: null,
  backends: [
    { provider: "anthropic", backend: "claude", ready: false, reason: "no key saved for anthropic" },
    { provider: "ollama", backend: "ollama", ready: true, reason: null },
  ],
};

const status = (over: Partial<CodeGraphStatus>): CodeGraphStatus => ({ ...BASE, ...over });

describe("what the header shows", () => {
  it("shows nothing for a folder without a graph or a build", () => {
    expect(headerView(status({}))).toEqual({ kind: "none" });
    expect(headerView(null)).toEqual({ kind: "none" });
  });

  it("shows a running build with its start and its last output line", () => {
    expect(headerView(status({ job: JOB }))).toEqual({
      kind: "running",
      since: "2026-10-09T10:00:00Z",
      lastLine: "[graphify extract] AST extraction on 2 code files...",
    });
  });

  it("shows the ready chip with the graph file's time when the build ended well", () => {
    const done: CodeGraphJob = { ...JOB, state: "ok", endedAt: "2026-10-09T10:02:00Z", exitCode: 0 };
    expect(
      headerView(status({ job: done, graph: { exists: true, modifiedAt: "2026-10-09T10:01:59Z" } })),
    ).toEqual({ kind: "ready", at: "2026-10-09T10:01:59Z" });
  });

  it("shows the ready chip for a graph that already exists when the session opens", () => {
    expect(headerView(status({ graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" } }))).toEqual({
      kind: "ready",
      at: "2026-10-08T07:30:00Z",
    });
  });

  it("shows the failed chip when the build failed, and keeps an older graph reachable beside it", () => {
    const failed: CodeGraphJob = { ...JOB, state: "failed", endedAt: "2026-10-09T10:01:00Z", exitCode: 1 };
    expect(
      headerView(status({ job: failed, graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" } })),
    ).toEqual({ kind: "failed", graph: { at: "2026-10-08T07:30:00Z" } });
  });

  it("shows the failed chip alone when the folder has no graph to fall back on", () => {
    const failed: CodeGraphJob = { ...JOB, state: "failed", endedAt: "2026-10-09T10:01:00Z", exitCode: 1 };
    expect(headerView(status({ job: failed }))).toEqual({ kind: "failed", graph: null });
  });
});

describe("the sheet's first choice", () => {
  it("offers update when the folder already has a graph", () => {
    expect(defaultMode(status({ graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" } }))).toBe(
      "update",
    );
  });

  it("offers a full build when it has none", () => {
    expect(defaultMode(status({}))).toBe("full");
    expect(defaultMode(null)).toBe("full");
  });
});

describe("the failure sheet", () => {
  it("shows the last twenty lines and no more", () => {
    const tail = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const failed: CodeGraphJob = { ...JOB, state: "failed", tail };
    const lines = failureLines(status({ job: failed }));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 6");
    expect(lines[19]).toBe("line 25");
  });
});

describe("polling", () => {
  it("polls while a build runs and stops when it has ended", () => {
    expect(pollDelay(status({ job: JOB }))).toBe(POLL_MS);
    expect(pollDelay(status({ job: { ...JOB, state: "ok" } }))).toBeNull();
    expect(pollDelay(status({}))).toBeNull();
  });
});

describe("the wire", () => {
  it("asks for the status of one session, or for the installation alone", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(BASE), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchCodeGraphStatus("s 1", fetchFn)).toEqual(BASE);
    expect(await fetchCodeGraphStatus(null, fetchFn)).toEqual(BASE);
    expect(asked).toEqual(["/api/codegraph/status?sessionId=s%201", "/api/codegraph/status"]);
  });

  it("answers null when the server cannot say", async () => {
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchCodeGraphStatus("s-1", down)).toBeNull();
    expect(await fetchCodeGraphStatus("s-1", missing)).toBeNull();
  });

  it("sends no labels as no provider and no model", () => {
    expect(startBody("s-1", "full", null, "ignored")).toEqual({
      sessionId: "s-1",
      mode: "full",
      provider: null,
      model: null,
    });
    expect(startBody("s-1", "update", "ollama", "qwen3:8b")).toEqual({
      sessionId: "s-1",
      mode: "update",
      provider: "ollama",
      model: "qwen3:8b",
    });
  });

  it("posts the start as json and hands back the server's own sentence on a refusal", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const refuse = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ message: "graphify is not installed." }), { status: 503 });
    }) as unknown as typeof fetch;

    const answer = await postCodeGraphStart(startBody("s-1", "full", null, null), refuse);

    expect(answer).toEqual({ status: 503, message: "graphify is not installed." });
    expect(sent[0].url).toBe("/api/codegraph/start");
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({
      sessionId: "s-1",
      mode: "full",
      provider: null,
      model: null,
    });
  });

  it("asks about the live session, or a stored one opened read-only, and never a scenario or an import", () => {
    // AC5: a stored session opened from the list shows the ready chip for its
    // folder before its next message; the server reads the folder from its record.
    expect(codeGraphSessionOf(true, "live-1", null)).toBe("live-1");
    expect(codeGraphSessionOf(true, null, null)).toBeNull();
    expect(codeGraphSessionOf(false, "live-1", "20261009-101500-cafecafe")).toBe("20261009-101500-cafecafe");
    expect(codeGraphSessionOf(false, "live-1", "scenario:fleet")).toBeNull();
    expect(codeGraphSessionOf(false, "live-1", "import:abc")).toBeNull();
    expect(codeGraphSessionOf(false, "live-1", null)).toBeNull();
  });
});

describe("the times", () => {
  it("shows the clock time for today and the date for an older file", () => {
    const now = new Date("2026-10-09T15:00:00Z");
    expect(shortTime("2026-10-09T10:02:00Z", "en", now, "UTC")).toBe("10:02");
    expect(shortTime("2026-10-08T07:30:00Z", "en", now, "UTC")).toBe("8 Oct, 07:30");
    expect(shortTime("2026-10-08T07:30:00Z", "de", now, "UTC")).toBe("8. Okt., 07:30");
  });
});

describe("the doctor row", () => {
  it("is fine with graphify installed and names where it is", () => {
    expect(codeGraphDoctorRow(status({}), "en")).toEqual({
      verdict: "ok",
      value: "graphify · /opt/tools/graphify",
    });
  });

  it("warns without graphify and gives the install line", () => {
    expect(codeGraphDoctorRow(status({ installed: false, binary: null }), "en")).toEqual({
      verdict: "warn",
      value: "not installed · uv tool install graphifyy",
    });
  });
});

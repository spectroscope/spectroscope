// Card 604: the store of the files tab's model reading. A stubbed fetch stands
// in for the server, so nothing here reaches the network: the cases pin what
// the request carries, that a reading belongs to the session it was asked for,
// and that a blocked localStorage costs the remembered pick and nothing else.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFilesEngine,
  filesAnalysisOf,
  loadPick,
  PICK_STORAGE_KEY,
  resetFilesAnalysis,
  savePick,
  startFilesAnalysis,
} from "./filesAnalysis";

/** A response whose body the case writes line by line, and closes when it likes. */
function controlledStream(): { response: Response; write: (line: object) => void; close: () => void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    write: (line) => ctrl.enqueue(enc.encode(JSON.stringify(line) + "\n")),
    close: () => ctrl.close(),
  };
}

/** A whole NDJSON answer at once. */
function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), { status: 200 });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PICK = { provider: "ollama", model: "qwen2.5:7b" };
const META = { provider: "ollama", model: "qwen2.5:7b", address: "localhost:11434" };

beforeEach(() => {
  for (const key of ["v", "a", "b"]) resetFilesAnalysis(key);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the files analysis store", () => {
  it("sendsTheChosenPair", async () => {
    const fetchMock = vi.fn(async () => ndjson([{ meta: META }, { delta: '{"files":[]}' }, { done: true }]));
    vi.stubGlobal("fetch", fetchMock);
    await startFilesAnalysis("v", "workspace: /ws\n#1 1.0s main ls: x", PICK, "de");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/files/analyze");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      digest: "workspace: /ws\n#1 1.0s main ls: x",
      provider: "ollama",
      model: "qwen2.5:7b",
      lang: "de",
    });
    const state = filesAnalysisOf("v");
    expect(state.status).toBe("done");
    expect(state.meta).toEqual(META);
    expect(state.text).toBe('{"files":[]}');
  });

  it("thePreflightAsksForThePickedPair", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: true, ...META })));
    vi.stubGlobal("fetch", fetchMock);
    const report = await fetchFilesEngine({ provider: "lm studio", model: "a/b c" });
    expect(report.available).toBe(true);
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/files/analyze/engine?provider=lm%20studio&model=a%2Fb%20c",
    ]);
    // A fence that answers 404 is an error, never a made-up report.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchFilesEngine(PICK)).rejects.toThrow();
  });

  it("aReadingStaysWithItsSession", async () => {
    const stream = controlledStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream.response),
    );
    const run = startFilesAnalysis("a", "digest of a", PICK, "en");
    stream.write({ meta: META });
    stream.write({ delta: '{"files":' });
    await flush();
    expect(filesAnalysisOf("a").status).toBe("running");
    expect(filesAnalysisOf("a").text).toBe('{"files":');
    expect(filesAnalysisOf("b")).toEqual({ status: "idle", meta: null, text: "", error: null });
    stream.write({ delta: "[]}" });
    stream.write({ done: true });
    stream.close();
    await run;
    expect(filesAnalysisOf("a").status).toBe("done");
    expect(filesAnalysisOf("b").status).toBe("idle");
  });

  it("aStreamCutShortIsAnError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjson([{ meta: META }, { delta: "{" }])),
    );
    await startFilesAnalysis("v", "d", PICK, "en");
    expect(filesAnalysisOf("v").status).toBe("error");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "pick a provider" }), { status: 400 })),
    );
    await startFilesAnalysis("v", "d", PICK, "en");
    expect(filesAnalysisOf("v")).toMatchObject({ status: "error", error: "pick a provider" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjson([{ meta: META }, { error: "model not found" }])),
    );
    await startFilesAnalysis("v", "d", PICK, "en");
    expect(filesAnalysisOf("v")).toMatchObject({ status: "error", error: "model not found" });
  });

  it("aBlockedStorageDoesNotBreakThePick", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(loadPick()).toBeNull();
    expect(() => savePick(PICK)).not.toThrow();
    // The positive twin: a working storage keeps the pick under its key.
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    });
    expect(loadPick()).toBeNull();
    savePick(PICK);
    expect(JSON.parse(kept.get(PICK_STORAGE_KEY) ?? "null")).toEqual(PICK);
    expect(loadPick()).toEqual(PICK);
    // A stored value that is not a pair is no pick.
    kept.set(PICK_STORAGE_KEY, '{"provider":"ollama"}');
    expect(loadPick()).toBeNull();
    kept.set(PICK_STORAGE_KEY, "not json");
    expect(loadPick()).toBeNull();
  });
});

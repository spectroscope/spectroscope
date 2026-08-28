// The run-analysis store (card 294): the OPT-IN one-shot reading of an
// imported run. The pins that matter: nothing fetches until startAnalysis is
// called (the consent click), the NDJSON driver lands meta/deltas/errors
// honestly, a stream cut before {done} is an error and not a result, and the
// structured parse is LENIENT — a model that answers prose instead of the
// asked JSON still renders as prose.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analysisOf,
  fetchAnalyzeEngine,
  parseAnalysisChunk,
  readAnalysis,
  resetAnalysis,
  startAnalysis,
} from "./runAnalysis";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A one-chunk NDJSON response body. */
function ndjson(lines: unknown[]): Pick<Response, "ok" | "body"> {
  const chunk = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  let served = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (served) return { done: true, value: undefined };
          served = true;
          return { done: false, value: chunk };
        },
      }),
    } as unknown as ReadableStream<Uint8Array>,
  };
}

describe("nothing leaves the machine without the click", () => {
  it("reading the store fires no fetch", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const state = analysisOf("import:quiet");
    expect(state.status).toBe("idle");
    resetAnalysis("import:quiet");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parseAnalysisChunk", () => {
  it("parses whole lines and keeps the partial tail pending", () => {
    const parsed = parseAnalysisChunk("", '{"delta":"a"}\n{"delta":"b"}\n{"del');
    expect(parsed.messages).toEqual([{ delta: "a" }, { delta: "b" }]);
    expect(parsed.pending).toBe('{"del');
  });

  it("skips an unparseable line without killing the run", () => {
    const parsed = parseAnalysisChunk("", 'not json\n{"done":true}\n');
    expect(parsed.messages).toEqual([{ done: true }]);
  });
});

describe("startAnalysis — the NDJSON driver", () => {
  it("lands meta, accumulates deltas, and finishes done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          { meta: { provider: "ollama", model: "glm-5.2:cloud", address: "localhost:11434" } },
          { delta: '{"summary":"fine",' },
          { delta: '"agents":[]}' },
          { done: true },
        ]),
      ),
    );
    await startAnalysis("import:a", "digest text", "en");
    const state = analysisOf("import:a");
    expect(state.status).toBe("done");
    expect(state.meta).toEqual({ provider: "ollama", model: "glm-5.2:cloud", address: "localhost:11434" });
    expect(state.text).toBe('{"summary":"fine","agents":[]}');
    expect(state.error).toBeNull();
  });

  it("sends the digest and the language, nothing else", async () => {
    let sent: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return ndjson([{ done: true }, { delta: "x" }]);
      }),
    );
    await startAnalysis("import:b", "the digest", "de");
    expect(sent).toEqual({ digest: "the digest", lang: "de" });
  });

  it("a non-ok response becomes the server's readable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "anthropic needs ANTHROPIC_API_KEY" }),
      })),
    );
    await startAnalysis("import:c", "digest", "en");
    const state = analysisOf("import:c");
    expect(state.status).toBe("error");
    expect(state.error).toBe("anthropic needs ANTHROPIC_API_KEY");
  });

  it("an {error} line is terminal and keeps the partial text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([
          { meta: { provider: "p", model: "m", address: "a" } },
          { delta: "partial " },
          { error: "connection reset" },
        ]),
      ),
    );
    await startAnalysis("import:d", "digest", "en");
    const state = analysisOf("import:d");
    expect(state.status).toBe("error");
    expect(state.error).toBe("connection reset");
    expect(state.text).toBe("partial ");
  });

  it("a stream cut before {done} is an error, never a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjson([{ meta: { provider: "p", model: "m", address: "a" } }, { delta: "half an answer" }]),
      ),
    );
    await startAnalysis("import:e", "digest", "en");
    const state = analysisOf("import:e");
    expect(state.status).toBe("error");
    expect(state.error).not.toBeNull();
    expect(state.text).toBe("half an answer");
  });

  it("re-analyzing resets the previous result before the new run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjson([{ delta: "second" }, { done: true }])),
    );
    await startAnalysis("import:f", "digest", "en");
    await startAnalysis("import:f", "digest", "en");
    expect(analysisOf("import:f").text).toBe("second");
  });
});

describe("fetchAnalyzeEngine", () => {
  it("hands back the server's report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, provider: "ollama", model: "m", address: "localhost:11434" }),
      })),
    );
    const report = await fetchAnalyzeEngine();
    expect(report).toEqual({ available: true, provider: "ollama", model: "m", address: "localhost:11434" });
  });

  it("throws on a non-200 rather than fabricating availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    await expect(fetchAnalyzeEngine()).rejects.toThrow("404");
  });
});

describe("readAnalysis — structured with a lenient fallback", () => {
  it("reads the asked-for JSON shape", () => {
    const parsed = readAnalysis(
      '{"summary":"The run finished.","agents":[{"id":"c1","reading":"Scouted the module."}]}',
    );
    expect(parsed).toEqual({
      summary: "The run finished.",
      agents: [{ id: "c1", reading: "Scouted the module." }],
    });
  });

  it("tolerates a code fence around the JSON", () => {
    const parsed = readAnalysis('```json\n{"summary":"ok","agents":[]}\n```');
    expect(parsed?.summary).toBe("ok");
  });

  it("tolerates prose around one JSON object", () => {
    const parsed = readAnalysis('Here is my reading:\n{"summary":"ok","agents":[]}\nHope that helps.');
    expect(parsed?.summary).toBe("ok");
  });

  it("drops malformed agent entries but keeps the good ones", () => {
    const parsed = readAnalysis(
      '{"summary":"ok","agents":[{"id":"c1","reading":"fine"},{"nope":true},"junk"]}',
    );
    expect(parsed?.agents).toEqual([{ id: "c1", reading: "fine" }]);
  });

  it("answers null for prose, which then renders as prose", () => {
    expect(readAnalysis("The run went fine, nothing to report.")).toBeNull();
  });

  it("answers null for JSON without a summary", () => {
    expect(readAnalysis('{"agents":[]}')).toBeNull();
  });
});

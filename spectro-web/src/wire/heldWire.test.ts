// Card 473: an imported session holds its wire in the browser, and the same
// two fetch functions every reader already calls (the trace's merge, the open
// exchange pane, the browser replay) answer from it. The fixture was written
// by the real recorders; the *.server.json files beside it are what the
// server's own index and exchange endpoints answered for those exact files,
// captured once, so these tests hold the browser to the server's answers.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBrowserAction, fetchBrowserWireIndex, readBrowserAction } from "./browserWire";
import { holdWires, heldLlmWire, readBrowserWire, readLlmWire, releaseHeldWires } from "./heldWire";
import { fetchLlmExchange, fetchLlmWireIndex, readExchange, readExchangeDetail } from "./llmWire";

const dir = fileURLToPath(new URL("../import/fixtures/bundle-473/", import.meta.url));
const id = readdirSync(dir)
  .find((n) => n.endsWith(".spectro.zip"))!
  .slice(0, -".spectro.zip".length);
const text = (suffix: string): string => readFileSync(`${dir}${id}${suffix}`, "utf8");
const json = (suffix: string): unknown => JSON.parse(text(suffix));

const IMPORT = "import:spectroscope:session.jsonl";

afterEach(() => {
  releaseHeldWires();
  vi.unstubAllGlobals();
});

/** A fetch that fails the test when anything reaches the network. */
function noNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("the held wire must answer without the server")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("readLlmWire", () => {
  it("indexes the file exactly as the server's index endpoint does", async () => {
    const held = await readLlmWire(text(".llm.jsonl"));
    expect(held).not.toBeNull();
    expect(held!.index).toEqual(json(".llm.index.server.json"));
  });

  it("skips a torn tail line and a line that is no object, as the server does", async () => {
    const torn = `${text(".llm.jsonl")}[1,2]\n{"type":"llm_request","xid":"0000`;
    const held = await readLlmWire(torn);
    expect(held!.index).toEqual(json(".llm.index.server.json"));
  });

  it("reads lines ended by CR LF and by a lone CR", async () => {
    const crlf = text(".llm.jsonl").replace(/\n/g, "\r\n");
    expect((await readLlmWire(crlf))!.index).toEqual(json(".llm.index.server.json"));
    const cr = text(".llm.jsonl").replace(/\n/g, "\r");
    expect((await readLlmWire(cr))!.index).toEqual(json(".llm.index.server.json"));
  });

  it("gives the reader the window back while a large wire is read, and stops when superseded", async () => {
    // About 8 MB: big enough that a reader holding the thread for all of it
    // would be one long task. The budget is per slice, so the count of
    // progress reports is the count of times the thread was handed back.
    const one = text(".llm.jsonl");
    const big = one.repeat(Math.ceil(8_000_000 / one.length));
    const reports: number[] = [];
    const held = await readLlmWire(big, { onProgress: (done) => reports.push(done), sliceMs: 4 });
    expect(held).not.toBeNull();
    expect(reports.length).toBeGreaterThan(1);
    expect(reports[reports.length - 1]).toBe(big.length);
    let calls = 0;
    const stopped = await readLlmWire(big, { isCurrent: () => ++calls < 2, sliceMs: 4 });
    expect(stopped).toBeNull();
  });
});

describe("readLlmWire on a wire with large lines", () => {
  it("hands the thread back between large lines, not only every 256 lines", async () => {
    // A real llm_request line carries the whole conversation, so a long
    // session's lines are hundreds of kilobytes. A reader that reads the
    // clock only every 256 lines reads forty such lines in one task.
    const body = "x".repeat(512 * 1024);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      const xid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      lines.push(JSON.stringify({ type: "llm_request", xid, turn: i, bodyBytes: body.length, body, ts: i }));
    }
    const big = lines.join("\n") + "\n";
    // A clock that moves 5 ms per reading makes the count of slices a
    // property of how often the reader looks, not of this machine's speed.
    let clock = 0;
    const now = (): number => (clock += 5);
    const reports: number[] = [];
    const held = await readLlmWire(big, { onProgress: (done) => reports.push(done), sliceMs: 12, now });
    expect(held!.index).toHaveLength(40);
    expect(reports.length).toBeGreaterThanOrEqual(10);
    expect(reports[reports.length - 1]).toBe(big.length);
  });
});

describe("an imported session answers from its held wire", () => {
  it("serves the index without asking the server", async () => {
    const spy = noNetwork();
    holdWires(IMPORT, { llm: (await readLlmWire(text(".llm.jsonl")))! });
    const rows = await fetchLlmWireIndex(IMPORT);
    const expected = (json(".llm.index.server.json") as unknown[]).map(readExchange);
    expect(rows).toEqual(expected);
    expect(rows).toHaveLength(3);
    expect(spy).not.toHaveBeenCalled();
  });

  it("opens an exchange: the request body and the response lines, as the server would", async () => {
    const spy = noNetwork();
    holdWires(IMPORT, { llm: (await readLlmWire(text(".llm.jsonl")))! });
    const xid = "43c25991-408c-42c8-b861-a9147791b65c";
    const detail = await fetchLlmExchange(IMPORT, xid);
    expect(detail).toEqual(readExchangeDetail(json(".llm.exchange.server.json")));
    // A positive pin beside the equality: the body is really there.
    expect(detail!.request.body).toContain("Grüß mich");
    expect(detail!.response.lines).toHaveLength(3);
    expect(detail!.response.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers an open exchange with a null response side, and an unknown xid with null", async () => {
    noNetwork();
    holdWires(IMPORT, { llm: (await readLlmWire(text(".llm.jsonl")))! });
    const open = await fetchLlmExchange(IMPORT, "155aa8ea-00fa-47b4-a3bf-a3c663cc59a6");
    expect(open!.request.body).toBe('{"turn":2}');
    expect(open!.response.fidelity).toBe("");
    expect(await fetchLlmExchange(IMPORT, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await fetchLlmExchange(IMPORT, "../x")).toBeNull();
  });

  it("serves the browser record's index and one action from the held browser wire", async () => {
    const spy = noNetwork();
    holdWires(IMPORT, { browser: (await readBrowserWire(text(".browser.jsonl")))! });
    const rows = await fetchBrowserWireIndex(IMPORT);
    expect(rows).toEqual((json(".browser.index.server.json") as unknown[]).map(readBrowserAction));
    expect(rows).toHaveLength(1);
    const action = await fetchBrowserAction(IMPORT, rows[0].cid);
    expect(action!.ok).toBe(true);
    expect(action!.result).toBe("Navigated to https://example.com/");
    expect(spy).not.toHaveBeenCalled();
  });

  it("still asks the server for a session that holds nothing", async () => {
    const spy = vi.fn(() => Promise.resolve(new Response("[]", { status: 200 })));
    vi.stubGlobal("fetch", spy);
    holdWires(IMPORT, { llm: (await readLlmWire(text(".llm.jsonl")))! });
    await fetchLlmWireIndex("20261009-000000-deadbeef");
    expect(spy).toHaveBeenCalledWith("/api/sessions/20261009-000000-deadbeef/llm-wire/index");
  });

  it("lets go of a held wire when released", async () => {
    holdWires(IMPORT, { llm: (await readLlmWire(text(".llm.jsonl")))! });
    expect(heldLlmWire(IMPORT)).not.toBeNull();
    releaseHeldWires();
    expect(heldLlmWire(IMPORT)).toBeNull();
  });
});

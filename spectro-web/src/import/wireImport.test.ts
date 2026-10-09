// Card 473: what an import finds beside a session, and where it looks.
//
// Three sources, in order: the bundle's own entries, the files dropped or
// picked together with a plain JSONL, and, for a plain JSONL whose wire exists
// on this machine, the server's wire folder, asked by the referenced name.
// The last one is the only one that leaves the browser, so its refusals are
// pinned here as hard as its answers.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { readZip } from "./bundleZip";
import { heldLlmWire, releaseHeldWires } from "../wire/heldWire";
import { fetchBrowserWireIndex } from "../wire/browserWire";
import { fetchLlmExchange, fetchLlmWireIndex } from "../wire/llmWire";
import {
  foundSentence,
  holdImportWires,
  readSpectroPick,
  resolveImportWires,
  sessionIdOfFileName,
  sortPickedNames,
  unpackBundle,
  wireIdOf,
  wireRefOf,
  type ImportWires,
} from "./wireImport";

const dir = fileURLToPath(new URL("./fixtures/bundle-473/", import.meta.url));
const zipName = readdirSync(dir).find((n) => n.endsWith(".spectro.zip"))!;
const id = zipName.slice(0, -".spectro.zip".length);
const text = (suffix: string): string => readFileSync(`${dir}${id}${suffix}`, "utf8");
const eventsOf = (body: string): RunEvent[] =>
  body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunEvent);

const NONE: ImportWires = { sessionFileName: null, llm: null, browser: null, children: [], from: "files" };

/** The fixture's events with the reference fields taken off its run_start:
 *  a session recorded before the fields existed. */
const unreferenced = (events: RunEvent[]): RunEvent[] =>
  events.map((e) => {
    if (e.type !== "run_start") return e;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { llmWire, browserWire, children, ...rest } = e;
    return rest;
  });

/** The fixture's events with its run_start naming exactly these files. */
const referencing = (
  events: RunEvent[],
  ref: { llmWire?: string; browserWire?: string; children: string[] },
) => unreferenced(events).map((e) => (e.type === "run_start" ? { ...e, ...ref } : e));

const browserCall: RunEvent = {
  type: "browser_action",
  agentId: "main",
  callId: "call-1",
  cid: "c1",
  epoch: 0,
  tool: "browser_navigate",
  ok: true,
  ts: 5,
} as unknown as RunEvent;

describe("the reference a session carries", () => {
  it("reads the reference fields of the main run_start", () => {
    expect(wireRefOf(eventsOf(text(".jsonl")))).toEqual({
      llmWire: `${id}.llm.jsonl`,
      browserWire: `${id}.browser.jsonl`,
      children: [],
    });
  });

  it("is absent on a session written before the fields existed", () => {
    expect(wireRefOf(unreferenced(eventsOf(text(".jsonl"))))).toBeNull();
  });

  it("joins a browser wire named on a later run_start, and ignores a child's run_start", () => {
    const events: RunEvent[] = [
      ...referencing(eventsOf(text(".jsonl")), { llmWire: `${id}.llm.jsonl`, children: [] }),
      {
        type: "run_start",
        runId: "c",
        agentId: "helper",
        parentId: "main",
        prompt: "x",
        llmWire: "evil.llm.jsonl",
        children: ["c9"],
        ts: 2,
      },
      {
        type: "run_start",
        runId: "r2",
        agentId: "main",
        prompt: "again",
        llmWire: `${id}.llm.jsonl`,
        browserWire: `${id}.browser.jsonl`,
        children: [],
        ts: 3,
      },
    ];
    expect(wireRefOf(events)).toEqual({
      llmWire: `${id}.llm.jsonl`,
      browserWire: `${id}.browser.jsonl`,
      children: [],
    });
  });

  it("turns a wire name into a session id only for the exact shape", () => {
    expect(wireIdOf(`${id}.llm.jsonl`, "llm")).toBe(id);
    expect(wireIdOf(`${id}.browser.jsonl`, "browser")).toBe(id);
    for (const evil of [
      `../${id}.llm.jsonl`,
      `a/${id}.llm.jsonl`,
      ".llm.jsonl",
      "..llm.jsonl",
      `${id}.browser.jsonl`,
      `${id}.llm.jsonl/x`,
      "%2e%2e.llm.jsonl",
      "",
    ]) {
      expect(wireIdOf(evil, "llm"), evil).toBeNull();
    }
    expect(sessionIdOfFileName(`${id}.jsonl`)).toBe(id);
    expect(sessionIdOfFileName(`${id}.llm.jsonl`)).toBeNull();
    expect(sessionIdOfFileName("pasted")).toBeNull();
  });
});

describe("what a pick or a drop holds", () => {
  it("separates a bundle and the two wires from the session files", () => {
    expect(sortPickedNames([`${id}.jsonl`, `${id}.llm.jsonl`, `${id}.browser.jsonl`])).toEqual({
      bundle: null,
      llm: 1,
      browser: 2,
      rest: [0],
    });
    expect(sortPickedNames(["notes.txt", `${id}.spectro.zip`])).toEqual({
      bundle: 1,
      llm: null,
      browser: null,
      rest: [0],
    });
  });

  it("unpacks the server's bundle into the session and its wires", async () => {
    const { session, wires } = unpackBundle(await readZip(new Uint8Array(readFileSync(dir + zipName))));
    expect(session).toEqual({ name: `${id}.jsonl`, text: text(".jsonl") });
    expect(wires.from).toBe("bundle");
    expect(wires.sessionFileName).toBe(`${id}.jsonl`);
    expect(wires.llm).toEqual({ name: `${id}.llm.jsonl`, text: text(".llm.jsonl") });
    expect(wires.browser).toEqual({ name: `${id}.browser.jsonl`, text: text(".browser.jsonl") });
    expect(wires.children).toEqual([]);
  });

  it("refuses a bundle without a session file", () => {
    const enc = new TextEncoder();
    expect(() => unpackBundle([{ name: "x.llm.jsonl", bytes: enc.encode("{}\n") }])).toThrow(/session/);
  });
});

describe("the local fallback", () => {
  it("asks the server for the referenced wires when only the session came", async () => {
    const fetchText = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("/llm-wire") ? text(".llm.jsonl") : null),
    );
    const got = await resolveImportWires(eventsOf(text(".jsonl")), NONE, fetchText);
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/llm-wire`);
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/browser-wire`);
    expect(got.llm).toEqual({ name: `${id}.llm.jsonl`, text: text(".llm.jsonl"), from: "local" });
    expect(got.browser).toBeNull();
    expect(got.report.missing).toEqual([`${id}.browser.jsonl`]);
  });

  it("resolves an old session by the id in its file name", async () => {
    const old = [...unreferenced(eventsOf(text(".jsonl"))), browserCall];
    const fetchText = vi.fn(() => Promise.resolve(null));
    const got = await resolveImportWires(old, { ...NONE, sessionFileName: `${id}.jsonl` }, fetchText);
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/llm-wire`);
    // It recorded a browser call, so it wrote a browser wire somewhere.
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/browser-wire`);
    expect(got.report.missing).toEqual([`${id}.llm.jsonl`, `${id}.browser.jsonl`]);
  });

  it("says none, and asks nothing, for a browser wire that was never written", async () => {
    // The reference names no browser wire and the session made no browser
    // call: the wire never existed, which is not the same as not found.
    const events = referencing(eventsOf(text(".jsonl")), { llmWire: `${id}.llm.jsonl`, children: [] });
    const fetchText = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("/llm-wire") ? text(".llm.jsonl") : "never"),
    );
    const got = await resolveImportWires(events, NONE, fetchText);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/llm-wire`);
    expect(got.browser).toBeNull();
    expect(got.report.none).toEqual(["browser"]);
    expect(got.report.missing).toEqual([]);
  });

  it("says none for an old session's browser wire when it made no browser call", async () => {
    const fetchText = vi.fn(() => Promise.resolve(null));
    const got = await resolveImportWires(
      unreferenced(eventsOf(text(".jsonl"))),
      { ...NONE, sessionFileName: `${id}.jsonl` },
      fetchText,
    );
    expect(fetchText).not.toHaveBeenCalledWith(`/api/sessions/${id}/browser-wire`);
    expect(got.report.none).toEqual(["browser"]);
    expect(got.report.missing).toEqual([`${id}.llm.jsonl`]);
  });

  it("still asks for a browser wire the reference leaves unnamed when a browser call says it was written", async () => {
    // Named on no run_start: the page was opened after the last one.
    const events = [
      ...referencing(eventsOf(text(".jsonl")), { llmWire: `${id}.llm.jsonl`, children: [] }),
      browserCall,
    ];
    const fetchText = vi.fn(() => Promise.resolve(null));
    const got = await resolveImportWires(events, NONE, fetchText);
    expect(fetchText).toHaveBeenCalledWith(`/api/sessions/${id}/browser-wire`);
    expect(got.report.none).toEqual([]);
    expect(got.report.missing).toEqual([`${id}.llm.jsonl`, `${id}.browser.jsonl`]);
  });

  it("never asks for a path-shaped name, and says the wire was not found", async () => {
    const forged = referencing(eventsOf(text(".jsonl")), {
      llmWire: "../../etc/passwd",
      browserWire: "a/b.browser.jsonl",
      children: [],
    });
    const fetchText = vi.fn(() => Promise.resolve("should never be read"));
    const got = await resolveImportWires(forged, NONE, fetchText);
    expect(fetchText).not.toHaveBeenCalled();
    expect(got.llm).toBeNull();
    expect(got.report.missing).toEqual(["../../etc/passwd", "a/b.browser.jsonl"]);
  });

  it("asks nothing for a pasted body without a reference", async () => {
    const old = unreferenced(eventsOf(text(".jsonl")));
    const fetchText = vi.fn(() => Promise.resolve(null));
    const got = await resolveImportWires(old, NONE, fetchText);
    expect(fetchText).not.toHaveBeenCalled();
    expect(got.report.missing).toEqual([]);
  });

  it("asks nothing when the wires came with the import", async () => {
    const fetchText = vi.fn(() => Promise.resolve(null));
    const got = await resolveImportWires(
      eventsOf(text(".jsonl")),
      {
        ...NONE,
        from: "bundle",
        llm: { name: `${id}.llm.jsonl`, text: text(".llm.jsonl") },
        browser: { name: `${id}.browser.jsonl`, text: text(".browser.jsonl") },
      },
      fetchText,
    );
    expect(fetchText).not.toHaveBeenCalled();
    expect(got.llm?.from).toBe("bundle");
    expect(got.browser?.from).toBe("bundle");
    expect(got.report.missing).toEqual([]);
  });

  it("never asks this machine for a wire a bundle does not carry", async () => {
    // A bundle is the other machine's whole record: a wire it does not carry
    // did not exist there. Asking this server for it found nothing useful and
    // left a 404 in the console on every bundle without a browser wire.
    const fetchText = vi.fn(() => Promise.resolve("{}\n"));
    const got = await resolveImportWires(
      eventsOf(text(".jsonl")),
      { ...NONE, from: "bundle", llm: { name: `${id}.llm.jsonl`, text: text(".llm.jsonl") } },
      fetchText,
    );
    expect(fetchText).not.toHaveBeenCalled();
    expect(got.llm?.from).toBe("bundle");
    expect(got.browser).toBeNull();
    // Positive control: the reference named it, so it is said to be missing.
    expect(got.report.missing).toEqual([`${id}.browser.jsonl`]);
  });

  it("counts the child sessions that came and names the ones that did not", async () => {
    const withChildren = referencing(eventsOf(text(".jsonl")), { children: ["c1", "c2"] });
    const got = await resolveImportWires(
      withChildren,
      { ...NONE, children: [{ name: "c1.jsonl", text: '{"type":"run_start"}\n' }] },
      () => Promise.resolve(null),
    );
    expect(got.children).toHaveLength(1);
    expect(got.report.missing).toEqual(["c2.jsonl"]);
  });
});

describe("the sentence the import says", () => {
  const report = {
    llm: { name: `${id}.llm.jsonl`, from: "bundle" as const, count: 3 },
    browser: { name: `${id}.browser.jsonl`, from: "local" as const, count: 1 },
    children: 0,
    none: [] as ("llm" | "browser")[],
    missing: ["c2.jsonl"],
  };

  it("names what it found with its counts, and what it did not find", () => {
    expect(foundSentence("en", report)).toBe(
      "Found: the session, the llm wire with 3 exchanges, the browser wire with 1 action (from this machine), 0 child sessions. Not found: c2.jsonl.",
    );
    expect(foundSentence("de", report)).toBe(
      "Gefunden: die Session, das LLM-Wire mit 3 Austauschen, das Browser-Wire mit 1 Aktion (von diesem Rechner), 0 Kind-Sessions. Nicht gefunden: c2.jsonl.",
    );
  });

  it("says plainly that no wire came", () => {
    expect(foundSentence("en", { llm: null, browser: null, children: 0, none: [], missing: [] })).toBe(
      "Found: the session, 0 child sessions. No wire came with it.",
    );
  });

  it("says none for a wire that was never written, and not found only for a missing one", () => {
    const said = foundSentence("en", { ...report, browser: null, none: ["browser"], missing: [] });
    expect(said).toBe(
      "Found: the session, the llm wire with 3 exchanges, no browser wire, 0 child sessions.",
    );
    expect(said).not.toMatch(/Not found/);
    expect(foundSentence("de", { ...report, browser: null, none: ["browser"], missing: [] })).toBe(
      "Gefunden: die Session, das LLM-Wire mit 3 Austauschen, kein Browser-Wire, 0 Kind-Sessions.",
    );
  });

  it("caps the names it repeats from an imported file, in count and in length", () => {
    // The names come from the imported file; a hostile or enormous one must
    // not flood the bar or forge a line of interface text.
    const long = "x".repeat(500);
    const missing = [`a\nForged line`, long, "c3.jsonl", "c4.jsonl", "c5.jsonl", "c6.jsonl", "c7.jsonl"];
    const said = foundSentence("en", { ...report, missing });
    expect(said).not.toContain("\n");
    expect(said).not.toContain(long);
    expect(said).toContain(`${"x".repeat(64)}…`);
    expect(said).toContain("c5.jsonl");
    expect(said).not.toContain("c6.jsonl");
    expect(said).toMatch(/and 2 more\.$/);
    // Positive control: a short list is said whole.
    expect(foundSentence("en", { ...report, missing: ["c2.jsonl"] })).toMatch(/Not found: c2\.jsonl\.$/);
  });

  it("has every key in both languages", () => {
    for (const key of Object.keys(dict).filter((k) => k.startsWith("imp.found."))) {
      const entry = dict[key as keyof typeof dict] as { en?: string; de?: string };
      expect(entry.en, key).toBeTruthy();
      expect(entry.de, key).toBeTruthy();
    }
  });
});

describe("an imported bundle, end to end", () => {
  afterEach(() => releaseHeldWires());
  const IMPORT = "import:spectroscope:bundle";

  it("holds the wires under the import's id, so an exchange opens and the counts are real", async () => {
    const { session, wires } = unpackBundle(await readZip(new Uint8Array(readFileSync(dir + zipName))));
    const network = vi.fn(() => Promise.resolve("never"));
    const report = await holdImportWires(IMPORT, eventsOf(session.text), wires, {}, network);
    expect(network).not.toHaveBeenCalled();
    expect(report).toEqual({
      llm: { name: `${id}.llm.jsonl`, from: "bundle", count: 3 },
      browser: { name: `${id}.browser.jsonl`, from: "bundle", count: 1 },
      children: 0,
      none: [],
      missing: [],
    });
    expect(await fetchLlmWireIndex(IMPORT)).toHaveLength(3);
    expect(await fetchBrowserWireIndex(IMPORT)).toHaveLength(1);
    const opened = await fetchLlmExchange(IMPORT, "43c25991-408c-42c8-b861-a9147791b65c");
    expect(opened?.request.body).toContain("Grüß mich");
  });

  it("reads the wire under the sign's progress and holds nothing when superseded", async () => {
    const { session, wires } = unpackBundle(await readZip(new Uint8Array(readFileSync(dir + zipName))));
    const reports: [number, number][] = [];
    await holdImportWires(IMPORT, eventsOf(session.text), wires, {
      onProgress: (done, total) => reports.push([done, total]),
    });
    const total = wires.llm!.text.length + wires.browser!.text.length;
    expect(reports[reports.length - 1]).toEqual([total, total]);
    releaseHeldWires();
    const stopped = await holdImportWires(IMPORT, eventsOf(session.text), wires, { isCurrent: () => false });
    expect(stopped).toBeNull();
    expect(heldLlmWire(IMPORT)).toBeNull();
  });

  it("checks once more right before holding, so a later import keeps its own wires", async () => {
    const { session, wires } = unpackBundle(await readZip(new Uint8Array(readFileSync(dir + zipName))));
    // A later import starts while the last slice runs: the readers have made
    // their last check by then, so only the check right before holding sees it.
    const run = async (supersedeAtTheEnd: boolean) => {
      let superseded = false;
      return holdImportWires(IMPORT, eventsOf(session.text), wires, {
        isCurrent: () => !superseded,
        onProgress: (done, total) => {
          if (supersedeAtTheEnd && done === total) superseded = true;
        },
      });
    };
    // Positive control: the same read, never superseded, holds the wire.
    expect(await run(false)).not.toBeNull();
    expect(heldLlmWire(IMPORT)).not.toBeNull();
    releaseHeldWires();
    expect(await run(true)).toBeNull();
    expect(heldLlmWire(IMPORT)).toBeNull();
  });
});

describe("a pick or a drop in the dialog", () => {
  /** A File-like over a fixture file, the two readers the dialog uses. */
  const file = (name: string, body: Uint8Array | string) => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return {
      name,
      text: () => Promise.resolve(new TextDecoder().decode(bytes)),
      arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    };
  };
  const fixture = (suffix: string) =>
    file(`${id}${suffix}`, new Uint8Array(readFileSync(`${dir}${id}${suffix}`)));

  it("opens a bundle", async () => {
    const got = await readSpectroPick([fixture(".spectro.zip")]);
    expect(got?.session.name).toBe(`${id}.jsonl`);
    expect(got?.wires.from).toBe("bundle");
    expect(got?.wires.llm?.text).toBe(text(".llm.jsonl"));
  });

  it("reports how far it got while it reads a bundle", async () => {
    const reports: number[] = [];
    const got = await readSpectroPick([fixture(".spectro.zip")], {
      onProgress: (done, total) => reports.push(done / total),
    });
    expect(got?.wires.llm?.text).toBe(text(".llm.jsonl"));
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]).toBe(1);
  });

  it("takes a session with its wires dropped beside it, in any order", async () => {
    const got = await readSpectroPick([fixture(".browser.jsonl"), fixture(".jsonl"), fixture(".llm.jsonl")]);
    expect(got?.session).toEqual({ name: `${id}.jsonl`, text: text(".jsonl") });
    expect(got?.wires).toEqual({
      sessionFileName: `${id}.jsonl`,
      llm: { name: `${id}.llm.jsonl`, text: text(".llm.jsonl") },
      browser: { name: `${id}.browser.jsonl`, text: text(".browser.jsonl") },
      children: [],
      from: "files",
    });
  });

  it("takes the other session files of a drop as its children", async () => {
    const got = await readSpectroPick([
      fixture(".jsonl"),
      fixture(".llm.jsonl"),
      file("c1.jsonl", '{"type":"run_start","runId":"c","agentId":"main","prompt":"x","ts":1}\n'),
    ]);
    expect(got?.session.name).toBe(`${id}.jsonl`);
    expect(got?.wires.children.map((c) => c.name)).toEqual(["c1.jsonl"]);
  });

  it("leaves a pick without a bundle or a wire to the existing grouping", async () => {
    expect(await readSpectroPick([fixture(".jsonl")])).toBeNull();
  });
});

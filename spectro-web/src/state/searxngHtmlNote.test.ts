// Card 448, criterion 4: the operator learns once per session that his SearXNG
// instance serves HTML only, and how to switch its JSON output on.
//
// The line is drawn from the web_search result itself. When the instance
// refuses JSON, the tool reads its HTML results page and says so in the result
// header; fixtures/web-search-searxng-html.txt holds that header exactly as the
// Java side prints it, and SearxngHtmlPageTest (spectro-core) holds the Java
// side to the same file. A header change on either side goes red somewhere.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import type { UiState } from "./reducer";
import { initialState, reduceAll } from "./reducer";
import { SEARXNG_HTML_NOTE_KEY, searxngHtmlAddress } from "./searxngHtmlNote";

const fromPage = readFileSync(path.join(__dirname, "fixtures", "web-search-searxng-html.txt"), "utf8");
const fromJson = fromPage.replace(/^Results \(searxng at [^)]*\)/, "Results (searxng)");

function call(callId: string, name = "web_search"): RunEvent {
  return { type: "tool_call", agentId: "main", callId, name, input: { query: "gradle kotlin dsl" }, ts: 1 };
}

function result(callId: string, output: string, isError = false): RunEvent {
  return { type: "tool_result", agentId: "main", callId, output, isError, durationMs: 5, ts: 2 };
}

function notes(state: UiState) {
  return state.turns.filter((turn) => turn.kind === "info" && turn.infoKey === SEARXNG_HTML_NOTE_KEY);
}

describe("the SearXNG HTML note (card 448)", () => {
  it("reads the address out of the header the tool prints", () => {
    expect(searxngHtmlAddress(fromPage)).toBe("http://box.local:8888");
  });

  it("finds nothing in a JSON answer's header", () => {
    // The guard on the fixture: the replacement above must have changed it,
    // or this test would pass on the page header itself.
    expect(fromJson).not.toBe(fromPage);
    expect(fromJson.startsWith("Results (searxng) for ")).toBe(true);
    expect(searxngHtmlAddress(fromJson)).toBeNull();
  });

  it("draws one info line when a web_search result came from the HTML page", () => {
    const state = reduceAll(initialState, [call("c1"), result("c1", fromPage)]);

    expect(notes(state)).toEqual([
      {
        kind: "info",
        text: dict[SEARXNG_HTML_NOTE_KEY].en.replace("{addr}", "http://box.local:8888"),
        tone: "neutral",
        infoKey: SEARXNG_HTML_NOTE_KEY,
        infoVars: { addr: "http://box.local:8888" },
      },
    ]);
  });

  it("draws it once per session, however many searches read the page", () => {
    const state = reduceAll(initialState, [
      call("c1"),
      result("c1", fromPage),
      call("c2"),
      result("c2", fromPage),
      call("c3"),
      result("c3", fromPage),
    ]);

    expect(notes(state)).toHaveLength(1);
  });

  it("stays away from a search that was answered in JSON", () => {
    const state = reduceAll(initialState, [call("c1"), result("c1", fromJson)]);

    expect(notes(state)).toHaveLength(0);
    // The positive half: the result did land on its card.
    expect(state.cards.c1.output).toBe(fromJson);
  });

  it("stays away from another tool whose output happens to carry the header", () => {
    const state = reduceAll(initialState, [call("c1", "read_file"), result("c1", fromPage)]);

    expect(notes(state)).toHaveLength(0);
    expect(state.cards.c1.output).toBe(fromPage);
  });

  it("stays away from a failed search", () => {
    const state = reduceAll(initialState, [call("c1"), result("c1", fromPage, true)]);

    expect(notes(state)).toHaveLength(0);
  });

  it("says the same fix in both languages, without a dash", () => {
    const entry = dict[SEARXNG_HTML_NOTE_KEY];
    expect(entry).toBeDefined();
    for (const text of [entry.de, entry.en]) {
      expect(text).toContain("{addr}");
      expect(text).toContain("search.formats");
      expect(text).toContain("settings.yml");
      expect(text).toContain("samples/09-searxng/install.sh");
      expect(text).toMatch(/\bjson\b/);
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

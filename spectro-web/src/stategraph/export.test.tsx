// The export view (net-new, owner-ordered): the drawing as a self-contained
// SVG built purely from layout data plus the lifecycle at the cursor, and the
// run as a Markdown summary — both leaving through the house download wiring
// (an anchor over an object URL, the way export/html.ts saves documents).
//
// layout.ts is deliberately DOM-free, which is what makes the SVG a
// data-to-string function this suite can hold without a browser.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutStateGraph } from "./layout";
import { readStateGraphRun } from "./artifact";
import { StateGraphView } from "./StateGraphView";
import { DEFAULT_VIEW } from "./viewState";
import { stateGraphSvg } from "./exportSvg";
import { stateGraphMarkdown } from "./exportMd";
import { exportStem } from "./StateGraphExport";
import { saveTextFile } from "../export/save";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");
const STATE = readFileSync(DIR + "crag-payload.state.jsonl", "utf8");

const lang = currentLang();
const run = readStateGraphRun(GRAPH, STATE);
const line = (o: object): string => JSON.stringify(o);
const jsonl = (...os: object[]): string => os.map(line).join("\n");

describe("the SVG is the drawing, self-contained", () => {
  const laid = layoutStateGraph(run.topology, "horizontal");
  const svg = stateGraphSvg({ run, laid, upto: run.records.length - 1, source: "crag-payload.graph.jsonl" });

  it("carries every node name and every rank label", () => {
    for (const n of run.topology.nodes) expect(svg).toContain(`>${n.label}</text>`);
    for (let r = 0; r <= laid.maxRank; r++) expect(svg).toContain(`rank ${r}`);
  });

  it("tints the border by lifecycle and marks walked edges", () => {
    expect(svg).toContain("x-n--done");
    expect(svg).toContain("x-n--pending"); // web never ran, and the file says so
    expect(svg).toContain("x-e--walked");
    expect(svg).toContain("x-e--untaken");
  });

  it("references nothing outside itself", () => {
    // The xmlns namespace NAME is an identifier, not a fetch — everything else
    // that smells of the network is a broken promise in a mailed file.
    const stripped = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
    expect(stripped).not.toMatch(/https?:/);
    expect(stripped).not.toContain("url(");
    expect(stripped).not.toContain("<link");
    expect(stripped).not.toContain("@import");
  });

  it("respects the orientation it was laid out in", () => {
    const vertical = stateGraphSvg({
      run,
      laid: layoutStateGraph(run.topology, "vertical"),
      upto: run.records.length - 1,
      source: "crag-payload.graph.jsonl",
    });
    expect(vertical).not.toBe(svg);
    for (let r = 0; r <= laid.maxRank; r++) expect(vertical).toContain(`rank ${r}`);
  });

  it("draws the lifecycle AT the cursor, not the run's end", () => {
    // Before the run reaches generate, its card must still read pending.
    const early = stateGraphSvg({ run, laid, upto: 0, source: "crag-payload.graph.jsonl" });
    const gen = early.slice(early.indexOf('data-id="generate"'), early.indexOf('data-id="generate"') + 120);
    expect(gen).toContain("x-n--pending");
  });

  it("escapes a hostile node label instead of shipping markup", () => {
    const topo = {
      entry: "a",
      nodes: [{ id: "a", label: 'a<b>&"' }],
      edges: [],
    };
    const g = jsonl({ type: "graph_topology", entry: "a", nodes: topo.nodes, edges: [] });
    const r = readStateGraphRun(g, null);
    const out = stateGraphSvg({
      run: r,
      laid: layoutStateGraph(r.topology, "horizontal"),
      upto: 0,
      source: "x.graph.jsonl",
    });
    expect(out).toContain("a&lt;b&gt;&amp;&quot;");
    expect(out).not.toContain("<b>");
  });
});

describe("the Markdown is the run summary", () => {
  const laid = layoutStateGraph(run.topology, "horizontal");
  const md = stateGraphMarkdown({ run, laid, source: "crag-payload.graph.jsonl", lang });

  it("names the source, the run and the counts", () => {
    expect(md).toContain("crag-payload.graph.jsonl");
    expect(md).toContain("bbf32a7d7199");
    expect(md).toContain(`${t(lang, "sg.supersteps")}: 11`);
    expect(md).toContain(`${t(lang, "sg.state")}: summary · 11`);
  });

  it("carries the node table, one honest row per node", () => {
    expect(md).toContain(
      `| ${t(lang, "sg.node")} | ${t(lang, "sg.rank")} | ${t(lang, "sg.lifecycle")} | ` +
        `${t(lang, "sg.superstep")} | ${t(lang, "sg.duration")} | ${t(lang, "sg.updateKeys")} |`,
    );
    // The router ran twice, at supersteps 0 and 5. Note the FOUR channels: the
    // node card clips its chips to three, but the summary prints the
    // artifact's whole truth — `trace` included.
    expect(md).toContain(
      `| router | 1 | ${t(lang, "sg.st.done")} | 0, 5 | 0 ms | query_used, route, principal, trace |`,
    );
    // web never ran — "never entered" is a different fact from "ran and wrote nothing".
    expect(md).toContain(`| web | 5 | ${t(lang, "sg.st.pending")} | — | — | — |`);
  });

  it("prints the thread when the artifact carries one, and no line when not", () => {
    expect(md).not.toContain(t(lang, "sg.thread"));
    const g = jsonl(
      {
        type: "graph_topology",
        entry: "a",
        nodes: [{ id: "a", label: "a" }],
        edges: [],
      },
      { type: "graph_start", runId: "r9", threadId: "t-42", ts: 1 },
      { type: "graph_end", steps: 1, ts: 2 },
    );
    const r = readStateGraphRun(g, null);
    expect(r.threadId).toBe("t-42");
    const out = stateGraphMarkdown({
      run: r,
      laid: layoutStateGraph(r.topology, "horizontal"),
      source: "x.graph.jsonl",
      lang,
    });
    expect(out).toContain(`${t(lang, "sg.thread")}: t-42`);
  });

  it("says which half is missing when no state file was loaded", () => {
    const bare = readStateGraphRun(GRAPH, null);
    const out = stateGraphMarkdown({ run: bare, laid, source: "crag-payload.graph.jsonl", lang });
    expect(out).toContain(t(lang, "sg.noStateFile"));
  });
});

describe("the files are named after the artifact's stem", () => {
  it("strips the artifact suffixes and nothing else", () => {
    expect(exportStem("crag-payload.graph.jsonl")).toBe("crag-payload");
    expect(exportStem("run.state.jsonl")).toBe("run");
    expect(exportStem("plain.jsonl")).toBe("plain");
    expect(exportStem("odd.name")).toBe("odd.name");
  });
});

describe("a download click walks the house export path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("saves through an anchor over an object URL and revokes it after", () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
    const appended: unknown[] = [];
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild: (n: unknown) => appended.push(n) },
    });
    const url = { createObjectURL: vi.fn(() => "blob:sg-1"), revokeObjectURL: vi.fn() };
    vi.stubGlobal("URL", url);
    vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });

    saveTextFile("crag-payload.svg", "<svg/>", "image/svg+xml;charset=utf-8");

    expect(anchor.download).toBe("crag-payload.svg");
    expect(anchor.href).toBe("blob:sg-1");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(appended.length).toBe(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    // The revoke waits a tick — revoking in the same one cancels the download.
    expect(url.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(url.revokeObjectURL).toHaveBeenCalledWith("blob:sg-1");
  });
});

describe("the affordance sits in the stategraph header row", () => {
  it("offers the export from the header actions", () => {
    const html = renderToStaticMarkup(
      <StateGraphView
        graphJsonl={GRAPH}
        stateJsonl={STATE}
        source="crag-payload.graph.jsonl"
        view={DEFAULT_VIEW}
        onView={() => {}}
      />,
    );
    const head = html.slice(0, html.indexOf("sg-transport"));
    expect(head).toContain(`>${t(lang, "exp.button")}<`);
  });
});

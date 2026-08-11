// The right panel's picked-node detail, rendered the way the pane's own suite
// renders the empty state: through react-dom/server, no document, no effects.
// The pick and the cursor are view state a server render cannot click into
// being, so NodeDetail takes both as props and the tests hand them in.
//
// What is pinned here is the owner's ordered picture: the panel shows the
// picked node AT the step the transport stands in — not its last visit — plus
// the documents a list channel kept, and the failure of the visit when there
// was one. The reference viewer (docs/graph-view-reference/graphview.html)
// already does all three; this suite is what keeps the rebuild honest.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeDetail } from "./StateGraphView";
import { readStateGraphRun, type StateGraphRun } from "./artifact";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");
const STATE = readFileSync(DIR + "crag-payload.state.jsonl", "utf8");

const run = readStateGraphRun(GRAPH, STATE);
const lang = currentLang();

const detail = (r: StateGraphRun, picked: string, upto: number): string =>
  renderToStaticMarkup(<NodeDetail run={r} rank={1} upto={upto} picked={picked} />);

/** The record index the transport would stand on — looked up, never hardcoded,
 *  so a regenerated fixture cannot silently shift the cursor under the suite. */
const idxOf = (r: StateGraphRun, type: string, node: string, superstep: number): number =>
  r.records.findIndex((x) => x.type === type && x.node === node && x.superstep === superstep);

const line = (o: object): string => JSON.stringify(o);
const jsonl = (...os: object[]): string => os.map(line).join("\n");

describe("the panel joins the payload per visit, not per node", () => {
  // The CRAG router runs twice: superstep 0 with the original question and
  // superstep 5 with the rewritten one. The s5 value extends the s0 value, so
  // the discriminating text is the rewrite's own suffix.
  const REWRITE_ONLY = "release signature approval";

  it("shows the visit the cursor stands in, and says which one", () => {
    const early = detail(run, "router", idxOf(run, "node_end", "router", 0));
    expect(early).toContain(`${t(lang, "sg.state")} · s0`);
    expect(early).not.toContain(REWRITE_ONLY);

    const late = detail(run, "router", run.records.length - 1);
    expect(late).toContain(`${t(lang, "sg.state")} · s5`);
    expect(late).toContain(REWRITE_ONLY);
  });

  it("moves the superstep row with the cursor as well", () => {
    expect(detail(run, "router", idxOf(run, "node_end", "router", 0))).toContain("<dd>0</dd>");
    expect(detail(run, "router", run.records.length - 1)).toContain("<dd>5</dd>");
  });

  it("falls forward to the first visit while the cursor has not reached the node", () => {
    // A picked node is a question about that node: before its first visit the
    // first visit is the honest answer, not an empty panel.
    const html = detail(run, "generate", 0);
    expect(html).toContain(`${t(lang, "sg.state")} · s9`);
    expect(html).toContain("change advisory board");
  });
});

describe("the documents strip", () => {
  it("lists every entry of a full list channel, index-labelled", () => {
    const html = detail(run, "generate", run.records.length - 1);
    expect(html).toContain("sg-docs");
    expect(html).toContain("[0]");
    expect(html).toContain("[3]");
    expect(html).toContain(t(lang, "sg.items", { n: 4 }));
    expect(html).toContain("Operations handbook, section 7 — maintenance and releases");
  });

  // The sampled marker carries the recorder's own truth: how many entries were
  // kept out of how many there were. The strip prints THAT number, never the
  // row count, and it renders the kept items instead of one opaque marker line.
  it("renders a sampled list marker's kept items with the n-of-m truth", () => {
    const g = jsonl(
      { type: "graph_start", runId: "r1", ts: 1 },
      { type: "node_start", node: "retrieve", superstep: 2, ts: 2 },
      {
        type: "node_end",
        node: "retrieve",
        superstep: 2,
        durationMs: 40,
        updateKeys: ["docs"],
        updateBytes: 39009,
        ts: 3,
      },
      { type: "graph_end", steps: 3, ts: 4 },
    );
    const s = jsonl(
      {
        type: "state_policy",
        runId: "r1",
        mode: "sample",
        caps: { docs: ["sample", 3, 512] },
        recordCap: 8192,
        redaction: "patterns",
        ts: 1,
      },
      {
        type: "state_payload",
        runId: "r1",
        node: "retrieve",
        superstep: 2,
        channels: {
          docs: {
            kind: "list",
            len: 8,
            bytes: 39009,
            omitted: "cap",
            sampled: 2,
            items: [
              {
                title: "Handbook section 0",
                text: { kind: "str", bytes: 4236, chars: 4200, omitted: "cap", head: "The release of…" },
              },
              {
                title: "Handbook section 1",
                text: { kind: "str", bytes: 4236, chars: 4200, omitted: "cap", head: "Sign-off happens…" },
              },
            ],
          },
        },
        truncated: ["docs"],
        ts: 3,
      },
    );
    const r = readStateGraphRun(g, s);
    const html = detail(r, "retrieve", r.records.length - 1);
    expect(html).toContain(t(lang, "sg.kept", { n: 2, m: 8 }));
    expect(html).toContain("Handbook section 0");
    expect(html).toContain("Handbook section 1");
    expect(html).toContain("[1]");
    // Two kept entries make two rows — a third would be an invention.
    expect(html).not.toContain("[2]");
  });

  it("renders an entry that is itself a byte-capped string as its marker line", () => {
    const g = jsonl(
      { type: "graph_start", runId: "r1", ts: 1 },
      { type: "node_start", node: "n", superstep: 0, ts: 2 },
      {
        type: "node_end",
        node: "n",
        superstep: 0,
        durationMs: 4,
        updateKeys: ["docs"],
        updateBytes: 900,
        ts: 3,
      },
      { type: "graph_end", steps: 1, ts: 4 },
    );
    const s = jsonl(
      {
        type: "state_policy",
        runId: "r1",
        mode: "sample",
        caps: {},
        recordCap: 8192,
        redaction: "patterns",
        ts: 1,
      },
      {
        type: "state_payload",
        runId: "r1",
        node: "n",
        superstep: 0,
        channels: {
          docs: {
            kind: "list",
            len: 3,
            bytes: 900,
            omitted: "cap",
            sampled: 1,
            items: [
              { kind: "str", bytes: 500, chars: 490, omitted: "cap", head: "the head of the clipped entry" },
            ],
          },
        },
        truncated: ["docs"],
        ts: 3,
      },
    );
    const r = readStateGraphRun(g, s);
    const html = detail(r, "n", r.records.length - 1);
    expect(html).toContain(t(lang, "sg.marker.str"));
  });

  // THE rule of the whole surface: a channel the policy dropped renders its
  // absence reason, never an empty list pretending to be data.
  it("keeps a dropped channel an absence, never an empty list", () => {
    const g = jsonl(
      { type: "graph_start", runId: "r1", ts: 1 },
      { type: "node_start", node: "n", superstep: 0, ts: 2 },
      {
        type: "node_end",
        node: "n",
        superstep: 0,
        durationMs: 4,
        updateKeys: ["docs"],
        updateBytes: 900,
        ts: 3,
      },
      { type: "graph_end", steps: 1, ts: 4 },
    );
    const s = jsonl({
      type: "state_policy",
      runId: "r1",
      mode: "sample",
      denied: ["docs"],
      caps: {},
      recordCap: 8192,
      redaction: "patterns",
      ts: 1,
    });
    const r = readStateGraphRun(g, s);
    const html = detail(r, "n", r.records.length - 1);
    const strip = html.slice(html.indexOf("sg-docs"));
    expect(strip).toContain(t(lang, "sg.notRecorded"));
    expect(strip).toContain("denied");
    expect(strip).not.toContain("[0]");
  });
});

describe("the error box", () => {
  // The shape the reference writer actually emits: `error` is a flat string
  // naming the class and `message` its sibling — artifact.ts already reads
  // them, and until now no component rendered either.
  const failed = readStateGraphRun(
    jsonl(
      { type: "graph_start", runId: "r1", ts: 1 },
      { type: "node_start", node: "verify", superstep: 11, ts: 2 },
      {
        type: "node_error",
        node: "verify",
        superstep: 11,
        durationMs: 410,
        error: "GroundednessError",
        message: "claim 3 cites doc[2] but no supporting span was found in it",
        ts: 3,
      },
      { type: "graph_end", steps: 12, ts: 4 },
    ),
    null,
  );

  it("shows class and message when the current visit raised", () => {
    const html = detail(failed, "verify", failed.records.length - 1);
    expect(html).toContain("sg-errbox");
    expect(html).toContain("GroundednessError");
    expect(html).toContain("no supporting span");
  });

  it("shows nothing before the failure has happened", () => {
    expect(detail(failed, "verify", idxOf(failed, "node_start", "verify", 11))).not.toContain("sg-errbox");
  });

  it("clears on a successful re-entry, and scrubbing back restores it", () => {
    const r = readStateGraphRun(
      jsonl(
        { type: "graph_start", runId: "r1", ts: 1 },
        { type: "node_start", node: "n", superstep: 1, ts: 2 },
        { type: "node_error", node: "n", superstep: 1, error: "Boom", message: "first visit raised", ts: 3 },
        { type: "node_start", node: "n", superstep: 2, ts: 4 },
        {
          type: "node_end",
          node: "n",
          superstep: 2,
          durationMs: 5,
          updateKeys: ["x"],
          updateBytes: 3,
          ts: 5,
        },
        { type: "graph_end", steps: 3, ts: 6 },
      ),
      null,
    );
    expect(detail(r, "n", r.records.length - 1)).not.toContain("sg-errbox");
    expect(detail(r, "n", idxOf(r, "node_error", "n", 1))).toContain("sg-errbox");
    expect(detail(r, "n", idxOf(r, "node_error", "n", 1))).toContain("Boom");
  });

  it("stays absent on a run that never raised", () => {
    expect(detail(run, "verify", run.records.length - 1)).not.toContain("sg-errbox");
  });
});

// t() hands back the key itself when the dictionary has no entry, so every
// toContain(t(...)) above would still pass with the dictionary forgotten —
// both sides would be the same bare key. Same pin as the pane suite's.
describe("the strip's chrome is reachable by the localisation", () => {
  it("has a word for every new key, in both languages", () => {
    for (const k of ["sg.documents", "sg.kept", "sg.item", "sg.items"]) {
      expect(t("de", k)).not.toBe(k);
      expect(t("en", k)).not.toBe(k);
    }
  });
});

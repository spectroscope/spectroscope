// The pane that owns which run is on screen.
//
// There is no DOM in this suite, so the two halves are tested the way the rest
// of this tree does it: the fold that decides what a file pick means is a pure
// function, and the empty state is rendered through react-dom/server, which
// needs no document and runs no effects.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEMO_SOURCE,
  PANE_KEYS,
  StateGraphPane,
  demoRun,
  foldPick,
  foldViewLoad,
  type LoadedRun,
} from "./StateGraphPane";
import { readStateGraphRun } from "./artifact";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

describe("the bundled demo run is a real artifact, not a stub", () => {
  const demo = demoRun();

  it("carries both files of the reference pair", () => {
    expect(demo.source).toBe(DEMO_SOURCE);
    expect(demo.stateJsonl).not.toBeNull();
  });

  // Measured off docs/graph-view-reference/crag-payload.*.jsonl on 2026-08-11:
  // 10 nodes, 14 edges, run bbf32a7d7199, steps 11, 11 payloads at mode
  // summary. A ?raw import that silently resolved to an empty string, or to the
  // wrong sibling, would still render a page — an empty one — so the numbers
  // are here rather than a truthiness check.
  it("parses into the CRAG topology and its values", () => {
    const run = readStateGraphRun(demo.graphJsonl, demo.stateJsonl);
    expect(run.topology.nodes.length).toBe(10);
    expect(run.topology.edges.length).toBe(14);
    expect(run.topology.entry).toBe("router");
    expect(run.runId).toBe("bbf32a7d7199");
    expect(run.supersteps).toBe(11);
    expect(run.policy?.mode).toBe("summary");
    expect(run.payloads.length).toBe(11);
    // The two files must not have been swapped: each side counts the other's
    // vocabulary as misfiled, so a swap shows up here and nowhere else.
    expect(run.misfiled).toBe(0);
    expect(run.badLines).toBe(0);
  });

  it("hands back a fresh object, so the pane cannot mutate the bundled text", () => {
    expect(demoRun()).not.toBe(demo);
    expect(demoRun()).toEqual(demo);
  });

  // src/stategraph/demo/ is a copy, and a copy forks. It exists only because
  // vite refuses to serve a module outside spectro-web (403 from the dev server,
  // "Denied ID" from vitest), so the reference under docs/ stays the original
  // and this asserts the two are still the same bytes. node:fs is not gated the
  // way the module graph is, which is what makes the comparison possible at all.
  it("is byte-identical to the reference under docs/graph-view-reference", () => {
    const original = (half: "graph" | "state"): string =>
      readFileSync(
        fileURLToPath(
          new URL(`../../../docs/graph-view-reference/crag-payload.${half}.jsonl`, import.meta.url),
        ),
        "utf8",
      );
    expect(demo.graphJsonl).toBe(original("graph"));
    expect(demo.stateJsonl).toBe(original("state"));
  });
});

describe("a file pick folds onto what is already drawn", () => {
  const loaded: LoadedRun = { graphJsonl: "G", stateJsonl: null, source: "a.graph.jsonl" };
  const pick = (name: string, text: string) => ({ name, text });

  it("draws the run a graph file names", () => {
    const next = foldPick(null, [pick("run.graph.jsonl", "G2")]);
    expect(next).toEqual({ graphJsonl: "G2", stateJsonl: null, source: "run.graph.jsonl" });
  });

  it("takes both when the picker reached both at once", () => {
    const next = foldPick(null, [pick("run.state.jsonl", "S"), pick("run.graph.jsonl", "G")]);
    expect(next).toEqual({ graphJsonl: "G", stateJsonl: "S", source: "run.graph.jsonl" });
  });

  // A file picker cannot reach a sibling, so the pair legitimately arrives in
  // two gestures, in either order. Replacing the drawing on the second one
  // would make the documented gesture impossible.
  it("attaches a values file to the drawing already on screen", () => {
    const next = foldPick(loaded, [pick("a.state.jsonl", "S")]);
    expect(next).toEqual({ graphJsonl: "G", stateJsonl: "S", source: "a.graph.jsonl" });
  });

  // The other half of the same rule: values belong to ONE run. Keeping the old
  // payloads under a new drawing joins two runs, which the reader has no way to
  // see and the artifact format exists to prevent.
  it("drops the previous run's values when a new drawing arrives alone", () => {
    const withValues: LoadedRun = { ...loaded, stateJsonl: "S" };
    const next = foldPick(withValues, [pick("b.graph.jsonl", "G2")]);
    expect(next).toEqual({ graphJsonl: "G2", stateJsonl: null, source: "b.graph.jsonl" });
  });

  it("has nothing to attach a lone values file to, and changes nothing", () => {
    expect(foldPick(null, [pick("a.state.jsonl", "S")])).toBeNull();
  });

  it("leaves the screen alone when the pick was empty", () => {
    expect(foldPick(loaded, [])).toBe(loaded);
  });

  // The reference page's own picker accepts .json/.jsonl/.ndjson, so a file
  // that carries neither suffix still has to land somewhere: as the drawing,
  // which is the half that can be rendered on its own.
  it("treats an unsuffixed single file as the drawing", () => {
    const next = foldPick(null, [pick("whatever.jsonl", "G")]);
    expect(next?.graphJsonl).toBe("G");
    expect(next?.stateJsonl).toBeNull();
  });
});

// StateGraphView owns a second picker, inside the loaded view, and it hands its
// result down as (graph, state, source) with the names already thrown away —
// except for the source. Its `find(...) ?? wanted[0]` falls back to the first
// file when no *.graph.jsonl is among them, so a user who picks the values file
// alone gets it delivered as the drawing. The source name is the only evidence
// left, and this seam is the last place that can read it.
describe("what the loaded view's own picker hands back", () => {
  const loaded: LoadedRun = { graphJsonl: "G", stateJsonl: null, source: "a.graph.jsonl" };

  it("replaces the run when a drawing arrives", () => {
    expect(foldViewLoad(loaded, "G2", "S2", "b.graph.jsonl")).toEqual({
      graphJsonl: "G2",
      stateJsonl: "S2",
      source: "b.graph.jsonl",
    });
  });

  it("attaches a values file the view mistook for a drawing", () => {
    expect(foldViewLoad(loaded, "S", null, "a.state.jsonl")).toEqual({
      graphJsonl: "G",
      stateJsonl: "S",
      source: "a.graph.jsonl",
    });
  });

  it("still has nothing to attach it to when no run is drawn", () => {
    expect(foldViewLoad(null, "S", null, "a.state.jsonl")).toBeNull();
  });
});

describe("the empty pane is honest about having no run", () => {
  const lang = currentLang();
  const html = renderToStaticMarkup(<StateGraphPane />);

  it("says the drawing exists before the first token", () => {
    expect(html).toContain(t(lang, "sg.claim"));
    expect(html).toContain(t(lang, "sg.empty.why"));
  });

  // A spinner promises an arrival. Nothing is on its way: a StateGraph's
  // topology is fixed at compile(), so an empty pane is a pane with no run
  // attached, and the only honest thing on it is an invitation.
  it("shows no spinner and no progress bar", () => {
    expect(html).not.toMatch(/spinner|is-loading|progressbar/);
  });

  it("offers both ways in: a file pick and the bundled run", () => {
    expect(html).toContain(t(lang, "sg.load"));
    expect(html).toContain(t(lang, "sg.demo"));
    expect(html).toContain('type="file"');
  });

  // Gated, not silent: a pane that quietly drew a canned run would teach its
  // first reader that they are looking at their own data.
  it("does not draw the demo until it is asked for", () => {
    expect(html).not.toContain("sg-canvas");
    expect(html).not.toContain(DEMO_SOURCE);
  });
});

describe("the pane's chrome is reachable by the localisation", () => {
  it("passes only sg.-namespaced keys to t()", () => {
    expect(PANE_KEYS.length).toBeGreaterThan(4);
    for (const k of PANE_KEYS) expect(k).toMatch(/^sg\./);
  });

  // t() hands back the key itself when the dictionary has no entry, so an
  // untranslated pane renders "sg.empty.title" on screen AND satisfies every
  // toContain(t(...)) above, because both sides are the same bare key. This is
  // the one assertion that can tell the two apart.
  it("has a word for every key, in both languages", () => {
    for (const k of PANE_KEYS) {
      expect(t("de", k)).not.toBe(k);
      expect(t("en", k)).not.toBe(k);
    }
  });
});

// The pane is mounted as a THIRD top-level view beside sessions and fleets, and
// that arm lives in App.tsx, where nothing in this suite can observe it. Read
// off disk, the same shape as the drift tests under components/.
describe("App mounts the pane as a view of its own", () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  it("renders it for the stategraph segment", () => {
    expect(read("../App.tsx")).toMatch(/nav === "stategraph" \? \(\s*<StateGraphPane \/>/);
  });

  // `nav` is component state, deliberately not URL vocabulary: the artifacts
  // arrive through a file picker, so a #/stategraph address would reopen an
  // empty pane and claim it was the graph the link pointed at.
  it("keeps the word out of the route vocabulary", () => {
    expect(read("../state/route.ts")).not.toContain("stategraph");
  });
});

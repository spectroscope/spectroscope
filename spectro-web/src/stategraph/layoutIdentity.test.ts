// Card 305: the engine learns to carry boxes bigger than its own cell, and the
// state graph must not move a pixel while it learns. This file is the ruler for
// that: the FULL serialised layout of the reference CRAG topology, in both
// orientations, captured from the engine as it stood before per-node sizes
// existed (commit a6da395d). Node for node, edge for edge, bound for bound.
//
// Every other test here asks whether some new behaviour works. This one asks
// the opposite question — whether anything old broke — and it is the reason the
// rest of the card could be built at all. A single changed coordinate fails it
// with the whole string in the diff, which is what a byte pin is for.
//
// If this ever needs updating, that is not a formatting decision: it means the
// picture the state-graph tab draws has moved, and somebody has to want that.
//
// UPDATED ONCE, at the card 303 + 305 merge, and NOT because the picture moved.
// Card 303 gives every rank label a `maxWidth`, so the serialisation carries a
// field that did not exist when this ruler was cut. The geometry underneath was
// proved untouched before these strings were replaced: with `maxWidth` stripped
// back out, the engine's output equalled the strings above byte for byte, in
// both orientations. Every node, edge, path, rule and bound is the number it
// was at a6da395d — the horizontal captions simply now also state 180 (a
// column's pitch less the gutter) and the vertical ones 316 (to the field's
// right edge). The pin stays a full-string comparison; it was regenerated, not
// relaxed, because a ruler that ignores a field stops measuring it.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** The reference CRAG topology, verbatim from the artifact's graph_topology
 *  record — the same one `layout.test.ts` measures against. */
const CRAG: Topology = {
  entry: "__start__",
  nodes: [
    "__start__",
    "router",
    "retrieve",
    "rerank",
    "grade",
    "rewrite",
    "web",
    "generate",
    "verify",
    "__end__",
  ].map((id) => ({ id, label: id })),
  edges: [
    { from: "__start__", to: "router", kind: "direct" },
    { from: "retrieve", to: "rerank", kind: "direct" },
    { from: "rerank", to: "grade", kind: "direct" },
    { from: "rewrite", to: "router", kind: "direct" },
    { from: "web", to: "generate", kind: "direct" },
    { from: "generate", to: "verify", kind: "direct" },
    { from: "router", to: "retrieve", kind: "conditional" },
    { from: "router", to: "web", kind: "conditional" },
    { from: "router", to: "generate", kind: "conditional" },
    { from: "grade", to: "generate", kind: "conditional" },
    { from: "grade", to: "rewrite", kind: "conditional" },
    { from: "grade", to: "web", kind: "conditional" },
    { from: "verify", to: "generate", kind: "conditional" },
    { from: "verify", to: "__end__", kind: "conditional" },
  ],
};

/** The engine's output for CRAG laid out horizontally, before card 305. */
const GOLDEN_HORIZONTAL =
  '{"nodes":[{"id":"__start__","label":"__start__","rank":0,"slot":0,"x":40,"y":76,"w":132,"h":46},{"id":"router","label":"router","rank":1,"slot":0,"x":230,"y":76,"w":132,"h":46},{"id":"retrieve","label":"retrieve","rank":2,"slot":0,"x":420,"y":76,"w":132,"h":46},{"id":"rerank","label":"rerank","rank":3,"slot":0,"x":610,"y":76,"w":132,"h":46},{"id":"grade","label":"grade","rank":4,"slot":0,"x":800,"y":76,"w":132,"h":46},{"id":"rewrite","label":"rewrite","rank":5,"slot":0.5,"x":990,"y":112,"w":132,"h":46},{"id":"web","label":"web","rank":5,"slot":-0.5,"x":990,"y":40,"w":132,"h":46},{"id":"generate","label":"generate","rank":6,"slot":0,"x":1180,"y":76,"w":132,"h":46},{"id":"verify","label":"verify","rank":7,"slot":0,"x":1370,"y":76,"w":132,"h":46},{"id":"__end__","label":"__end__","rank":8,"slot":0,"x":1560,"y":76,"w":132,"h":46}],"edges":[{"id":"__start__->router","from":"__start__","to":"router","kind":"direct","back":false,"skip":false,"path":"M172,99 L230,99","labelX":201,"labelY":92},{"id":"retrieve->rerank","from":"retrieve","to":"rerank","kind":"direct","back":false,"skip":false,"path":"M552,99 L610,99","labelX":581,"labelY":92},{"id":"rerank->grade","from":"rerank","to":"grade","kind":"direct","back":false,"skip":false,"path":"M742,99 L800,99","labelX":771,"labelY":92},{"id":"rewrite->router","from":"rewrite","to":"router","kind":"direct","back":true,"skip":false,"path":"M990,135 L975,135 Q960,135 960,150 L960,186 Q960,204 942,204 L218,204 Q200,204 200,186 L200,114 Q200,99 215,99 L230,99","labelX":580,"labelY":221},{"id":"web->generate","from":"web","to":"generate","kind":"direct","back":false,"skip":false,"path":"M1122,63 C1148.1,63 1153.9,99 1180,99","labelX":1151,"labelY":74},{"id":"generate->verify","from":"generate","to":"verify","kind":"direct","back":false,"skip":false,"path":"M1312,99 L1370,99","labelX":1341,"labelY":92},{"id":"router->retrieve","from":"router","to":"retrieve","kind":"conditional","back":false,"skip":false,"path":"M362,99 L420,99","labelX":391,"labelY":92},{"id":"router->web","from":"router","to":"web","kind":"conditional","back":false,"skip":true,"path":"M362,99 L377,99 Q392,99 392,84 L392,16 Q392,-2 410,-2 L942,-2 Q960,-2 960,16 L960,48 Q960,63 975,63 L990,63","labelX":676,"labelY":-11},{"id":"router->generate","from":"router","to":"generate","kind":"conditional","back":false,"skip":true,"path":"M362,99 L377,99 Q392,99 392,84 L392,-20 Q392,-38 410,-38 L1132,-38 Q1150,-38 1150,-20 L1150,84 Q1150,99 1165,99 L1180,99","labelX":771,"labelY":-47},{"id":"grade->generate","from":"grade","to":"generate","kind":"conditional","back":false,"skip":false,"path":"M932,99 L1180,99","labelX":1056,"labelY":92},{"id":"grade->rewrite","from":"grade","to":"rewrite","kind":"conditional","back":false,"skip":false,"path":"M932,99 C958.1,99 963.9,135 990,135","labelX":961,"labelY":110},{"id":"grade->web","from":"grade","to":"web","kind":"conditional","back":false,"skip":false,"path":"M932,99 C958.1,99 963.9,63 990,63","labelX":961,"labelY":74},{"id":"verify->generate","from":"verify","to":"generate","kind":"conditional","back":true,"skip":false,"path":"M1370,99 L1355,99 Q1340,99 1340,114 L1340,222 Q1340,240 1322,240 L1168,240 Q1150,240 1150,222 L1150,114 Q1150,99 1165,99 L1180,99","labelX":1245,"labelY":257},{"id":"verify->__end__","from":"verify","to":"__end__","kind":"conditional","back":false,"skip":false,"path":"M1502,99 L1560,99","labelX":1531,"labelY":92}],"maxRank":8,"rankLabels":[{"rank":0,"x":40,"y":28,"maxWidth":180},{"rank":1,"x":230,"y":28,"maxWidth":180},{"rank":2,"x":420,"y":28,"maxWidth":180},{"rank":3,"x":610,"y":28,"maxWidth":180},{"rank":4,"x":800,"y":28,"maxWidth":180},{"rank":5,"x":990,"y":28,"maxWidth":180},{"rank":6,"x":1180,"y":28,"maxWidth":180},{"rank":7,"x":1370,"y":28,"maxWidth":180},{"rank":8,"x":1560,"y":28,"maxWidth":180}],"rankRules":[{"rank":0,"x1":11,"y1":-4000,"x2":11,"y2":4000},{"rank":1,"x1":201,"y1":-4000,"x2":201,"y2":4000},{"rank":2,"x1":391,"y1":-4000,"x2":391,"y2":4000},{"rank":3,"x1":581,"y1":-4000,"x2":581,"y2":4000},{"rank":4,"x1":771,"y1":-4000,"x2":771,"y2":4000},{"rank":5,"x1":961,"y1":-4000,"x2":961,"y2":4000},{"rank":6,"x1":1151,"y1":-4000,"x2":1151,"y2":4000},{"rank":7,"x1":1341,"y1":-4000,"x2":1341,"y2":4000},{"rank":8,"x1":1531,"y1":-4000,"x2":1531,"y2":4000}],"bounds":{"x0":0,"y0":-100,"x1":1732,"y1":302}}';

/** The same, laid out vertically. */
const GOLDEN_VERTICAL =
  '{"nodes":[{"id":"__start__","label":"__start__","rank":0,"slot":0,"x":126,"y":40,"w":132,"h":46},{"id":"router","label":"router","rank":1,"slot":0,"x":126,"y":132,"w":132,"h":46},{"id":"retrieve","label":"retrieve","rank":2,"slot":0,"x":126,"y":224,"w":132,"h":46},{"id":"rerank","label":"rerank","rank":3,"slot":0,"x":126,"y":316,"w":132,"h":46},{"id":"grade","label":"grade","rank":4,"slot":0,"x":126,"y":408,"w":132,"h":46},{"id":"rewrite","label":"rewrite","rank":5,"slot":0.5,"x":212,"y":500,"w":132,"h":46},{"id":"web","label":"web","rank":5,"slot":-0.5,"x":40,"y":500,"w":132,"h":46},{"id":"generate","label":"generate","rank":6,"slot":0,"x":126,"y":592,"w":132,"h":46},{"id":"verify","label":"verify","rank":7,"slot":0,"x":126,"y":684,"w":132,"h":46},{"id":"__end__","label":"__end__","rank":8,"slot":0,"x":126,"y":776,"w":132,"h":46}],"edges":[{"id":"__start__->router","from":"__start__","to":"router","kind":"direct","back":false,"skip":false,"path":"M192,86 L192,132","labelX":192,"labelY":102},{"id":"retrieve->rerank","from":"retrieve","to":"rerank","kind":"direct","back":false,"skip":false,"path":"M192,270 L192,316","labelX":192,"labelY":286},{"id":"rerank->grade","from":"rerank","to":"grade","kind":"direct","back":false,"skip":false,"path":"M192,362 L192,408","labelX":192,"labelY":378},{"id":"rewrite->router","from":"rewrite","to":"router","kind":"direct","back":true,"skip":false,"path":"M278,500 L278,485 Q278,470 293,470 L372,470 Q390,470 390,452 L390,120 Q390,102 372,102 L207,102 Q192,102 192,117 L192,132","labelX":403,"labelY":286},{"id":"web->generate","from":"web","to":"generate","kind":"direct","back":false,"skip":false,"path":"M106,546 C106,570 192,568 192,592","labelX":149,"labelY":562},{"id":"generate->verify","from":"generate","to":"verify","kind":"direct","back":false,"skip":false,"path":"M192,638 L192,684","labelX":192,"labelY":654},{"id":"router->retrieve","from":"router","to":"retrieve","kind":"conditional","back":false,"skip":false,"path":"M192,178 L192,224","labelX":192,"labelY":194},{"id":"router->web","from":"router","to":"web","kind":"conditional","back":false,"skip":true,"path":"M192,178 L192,193 Q192,208 177,208 L16,208 Q-2,208 -2,226 L-2,452 Q-2,470 16,470 L91,470 Q106,470 106,485 L106,500","labelX":-13,"labelY":339},{"id":"router->generate","from":"router","to":"generate","kind":"conditional","back":false,"skip":true,"path":"M192,178 L192,193 Q192,208 177,208 L-20,208 Q-38,208 -38,226 L-38,544 Q-38,562 -20,562 L177,562 Q192,562 192,577 L192,592","labelX":-49,"labelY":385},{"id":"grade->generate","from":"grade","to":"generate","kind":"conditional","back":false,"skip":false,"path":"M192,454 L192,592","labelX":192,"labelY":516},{"id":"grade->rewrite","from":"grade","to":"rewrite","kind":"conditional","back":false,"skip":false,"path":"M192,454 C192,478 278,476 278,500","labelX":235,"labelY":470},{"id":"grade->web","from":"grade","to":"web","kind":"conditional","back":false,"skip":false,"path":"M192,454 C192,478 106,476 106,500","labelX":149,"labelY":470},{"id":"verify->generate","from":"verify","to":"generate","kind":"conditional","back":true,"skip":false,"path":"M192,684 L192,669 Q192,654 207,654 L408,654 Q426,654 426,636 L426,580 Q426,562 408,562 L207,562 Q192,562 192,577 L192,592","labelX":439,"labelY":608},{"id":"verify->__end__","from":"verify","to":"__end__","kind":"conditional","back":false,"skip":false,"path":"M192,730 L192,776","labelX":192,"labelY":746}],"maxRank":8,"rankLabels":[{"rank":0,"x":18,"y":32,"maxWidth":316},{"rank":1,"x":18,"y":124,"maxWidth":316},{"rank":2,"x":18,"y":216,"maxWidth":316},{"rank":3,"x":18,"y":308,"maxWidth":316},{"rank":4,"x":18,"y":400,"maxWidth":316},{"rank":5,"x":18,"y":492,"maxWidth":316},{"rank":6,"x":18,"y":584,"maxWidth":316},{"rank":7,"x":18,"y":676,"maxWidth":316},{"rank":8,"x":18,"y":768,"maxWidth":316}],"rankRules":[{"rank":0,"x1":-4000,"y1":17,"x2":4000,"y2":17},{"rank":1,"x1":-4000,"y1":109,"x2":4000,"y2":109},{"rank":2,"x1":-4000,"y1":201,"x2":4000,"y2":201},{"rank":3,"x1":-4000,"y1":293,"x2":4000,"y2":293},{"rank":4,"x1":-4000,"y1":385,"x2":4000,"y2":385},{"rank":5,"x1":-4000,"y1":477,"x2":4000,"y2":477},{"rank":6,"x1":-4000,"y1":569,"x2":4000,"y2":569},{"rank":7,"x1":-4000,"y1":661,"x2":4000,"y2":661},{"rank":8,"x1":-4000,"y1":753,"x2":4000,"y2":753}],"bounds":{"x0":-112,"y0":0,"x1":496,"y1":862}}';

describe("the state graph does not move", () => {
  it("lays the reference topology out horizontally exactly as it did before per-node sizes", () => {
    expect(JSON.stringify(layoutStateGraph(CRAG, "horizontal"))).toBe(GOLDEN_HORIZONTAL);
  });

  it("lays the reference topology out vertically exactly as it did before per-node sizes", () => {
    // The vertical half matters more, not less: card 305 lifts a refusal that
    // lived only on this path, so this is the string that would catch a lift
    // that also moved the boxes nobody asked to move.
    expect(JSON.stringify(layoutStateGraph(CRAG, "vertical"))).toBe(GOLDEN_VERTICAL);
  });

  it("is unmoved by an EMPTY size map, which is not the same as no map at all", () => {
    // A caller that builds sizes conditionally hands in an empty map rather
    // than omitting the field. That must be the no-op the omission is, or the
    // identity above holds for a case nobody actually calls.
    const empty = { ...CRAG, sizes: new Map() };
    expect(JSON.stringify(layoutStateGraph(empty, "horizontal"))).toBe(GOLDEN_HORIZONTAL);
    expect(JSON.stringify(layoutStateGraph(empty, "vertical"))).toBe(GOLDEN_VERTICAL);
  });

  it("is unmoved by sizes that state exactly the engine's own cell", () => {
    // The equality that makes the whole override safe: a stated 132x46 must
    // reduce to the arithmetic it replaced, not merely land near it.
    const same = new Map(CRAG.nodes.map((n) => [n.id, { w: 132, h: 46 }]));
    expect(JSON.stringify(layoutStateGraph({ ...CRAG, sizes: same }, "horizontal"))).toBe(GOLDEN_HORIZONTAL);
    expect(JSON.stringify(layoutStateGraph({ ...CRAG, sizes: same }, "vertical"))).toBe(GOLDEN_VERTICAL);
  });
});

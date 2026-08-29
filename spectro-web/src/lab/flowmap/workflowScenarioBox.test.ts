// Card 306: the SHIPPED scenario has to draw a box, and it did not.
//
// Measured in the running app before this file existed: loading "Declared
// workflow · 5 phases, 13 agents" and scrubbing into it drew the agents as
// loose cards and NOTHING matching `wfbox`. The declaration was never the
// problem — `registry.ts` states the five phases, `declarationOf` turns them
// into a `WorkflowDeclaration`, and `App` hands that to the lab. The map threw
// it away one line later: a declaration is drawn only where the node it hangs
// on is a card the scene drew, and the check asked `scene.subagents` alone.
//
// A scenario's agents hang under the SESSION's own agent — `expandSpawn` and
// `expandFanout` both write `parentId: "main"` — and the session's agent is
// not one of its own children. So the box was skipped for every scenario ever
// shipped, while an imported run (whose declaration hangs on the `Workflow`
// tool_use's own card) drew one.
//
// Nothing here is special-cased for scenarios. The whole chain is the real
// one: the shipped DSL, the real compiler, the real scene fold, the real
// `declarationOf`, the real `sceneToFlow`.

import { describe, expect, it } from "vitest";
import { compile, declarationOf } from "../../scenario/compile";
import { SCENARIOS } from "../../scenario/registry";
import { advanceScene, initialScene } from "../labScene";
import { boxNodeId, deriveDetail, sceneToFlow } from "./sceneToFlow";
import { worldBoxes } from "./worldBox";

const DSL = SCENARIOS.find((s) => s.id === "workflow-phases")!;

/** The compiled scenario, stopped one event short of its own `run_end`.
 *
 *  The root's `run_end` retires every child — that is the scene fold's rule
 *  for the run being over, not a quirk of this file — so the whole stream
 *  folded to the end holds no children at all and could not show a box even
 *  if every other part were right. The reader who sees the box is scrubbed
 *  INTO the run, which is exactly this prefix. */
const flowOf = (lang: "en" | "de" = "en") => {
  const events = compile(DSL, lang).slice(0, -1);
  const scene = events.reduce(advanceScene, initialScene());
  return {
    scene,
    flow: sceneToFlow(scene, deriveDetail(events), {
      provider: "ollama",
      model: "m",
      lang,
      declared: declarationOf(DSL, lang),
    }),
  };
};

describe("the shipped workflow scenario draws its box", () => {
  it("declares five phases holding 1 / 5 / 1 / 1 / 5", () => {
    // The shape the demo exists to show, straight off the DSL. If this moves,
    // every count below moves with it and says so.
    const run = declarationOf(DSL, "en")!.get("main")!;
    expect(run.phases.map((p) => p.members.length)).toEqual([1, 5, 1, 1, 5]);
  });

  it("puts ONE box on the map", () => {
    const { flow } = flowOf();
    expect(flow.nodes.filter((n) => n.type === "wfbox").map((n) => n.id)).toEqual([boxNodeId("main")]);
  });

  it("gives that box five bands holding 1 / 5 / 1 / 1 / 5", () => {
    const { flow } = flowOf();
    const box = flow.nodes.find((n) => n.type === "wfbox")!;
    const d = box.data as { bands: { title: string; count: number }[] };
    expect(d.bands.map((b) => b.count)).toEqual([1, 5, 1, 1, 5]);
    expect(d.bands.map((b) => b.title)).toEqual(["scope", "probe", "merge", "draft", "audit"]);
  });

  it("names its bands in the reader's language", () => {
    const { flow } = flowOf("de");
    const box = flow.nodes.find((n) => n.type === "wfbox")!;
    const d = box.data as { bands: { title: string }[] };
    expect(d.bands.map((b) => b.title)).toEqual([
      "abstecken",
      "abtasten",
      "zusammenlegen",
      "entwerfen",
      "nachprüfen",
    ]);
  });

  it("stands all thirteen agents IN the box — none of them loose", () => {
    const { flow } = flowOf();
    const boxId = boxNodeId("main");
    const inBox = flow.nodes.filter((n) => n.parentId === boxId).map((n) => n.id);
    expect(inBox).toHaveLength(13);
    expect(flow.nodes.filter((n) => n.type === "subagent" && n.parentId === undefined)).toEqual([]);
  });

  it("seats every one of them inside the box's own rectangle", () => {
    const { flow } = flowOf();
    const boxId = boxNodeId("main");
    const world = worldBoxes(flow.nodes as { id: string; position: { x: number; y: number } }[]);
    const box = flow.nodes.find((n) => n.id === boxId)!;
    const style = box.style as { width: number; height: number };
    const at = world.get(boxId)!;
    for (const n of flow.nodes.filter((k) => k.parentId === boxId)) {
      const m = world.get(n.id)!;
      expect(m.x).toBeGreaterThanOrEqual(at.x);
      expect(m.y).toBeGreaterThanOrEqual(at.y);
      expect(m.x).toBeLessThanOrEqual(at.x + style.width);
      expect(m.y).toBeLessThanOrEqual(at.y + style.height);
    }
  });

  it("names itself in words rather than in the fold's own id for the root", () => {
    // A run hanging on the session has no child card to take a name from, and
    // "main" is this fold's internal spelling. Both locales, because a box
    // header is a user-visible string.
    const en = flowOf().flow.nodes.find((n) => n.type === "wfbox")!.data as { title: string };
    const de = flowOf("de").flow.nodes.find((n) => n.type === "wfbox")!.data as { title: string };
    expect(en.title).toBe("workflow run");
    expect(de.title).toBe("Workflow-Lauf");
  });

  it("keeps the session's own agent card, because the box is not that card", () => {
    // The run this box belongs to IS the session, and the session's agent card
    // is not one of its children. Folding it away — the rule that applies when
    // the run has a child card of its own — would delete the hub every rail on
    // the map runs through.
    const { flow } = flowOf();
    expect(flow.nodes.map((n) => n.id)).toContain("agent");
  });
});

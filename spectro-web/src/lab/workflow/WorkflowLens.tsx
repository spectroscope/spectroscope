// The Lab's workflow lens (card 293): the run's agents as a topology — the
// spawn tree ranked by time overlap — instead of the machine map. Same
// stepper, same cursor, same scene fold; only the projection changes.
//
// CARD 302 gave the lens a SECOND picture, and the stroke is what tells them
// apart. Dashed still means reconstructed from what happened — a Task spawn
// tree, columns guessed from the stamps. Solid means the run declared its
// columns before it started: a workflow's `phases` sit in its script before a
// token flows, and the lens ranks and captions by them.
//
// One picture can hold BOTH, which is why the stroke is decided per edge and
// not once for the canvas: the spawn of a workflow is itself a reconstruction,
// and a run can spawn plain Task children beside a declared workflow. The
// legend therefore explains both strokes rather than only the one the tree
// happens to lead with, and the honesty chip counts what the reconstruction
// resolved either way.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { Node as FlowNode, NodeTypes } from "@xyflow/react";
import type { RunEvent } from "../../events";
import type { Scene } from "../labScene";
import { layoutStateGraph, type StateGraphLayout } from "../../stategraph/layout";
import { GraphCanvas } from "../../reactflow/GraphCanvas";
import { RefitOnLayout } from "../../reactflow/RefitOnLayout";
import { nodeStateAt, phaseStateAt, spawnedIn, spawnTree, terminalStatesIn } from "../spawnTree";
import type { WorkflowDeclaration } from "../workflowGraph";
import { WorkflowNode, type WfData } from "./WorkflowNode";
import { t, type Lang } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import "./workflow.css";

/** The lab's two lenses. */
export type LabLens = "machine" | "workflow";

/** The stored choice, defaulting to the machine lens — same contract as the
 *  compact/expanded toggle: only an explicit, well-formed choice flips it. */
export function lensFrom(stored: string | null): LabLens {
  return stored === "workflow" ? "workflow" : "machine";
}

// Re-exported so the card's markup pins keep their import path.
export { WorkflowNode };

const NODE_TYPES: NodeTypes = { wfNode: WorkflowNode };

/** The caption band (card 303). `rankLabels[].y` is where the caption's
 *  BASELINE used to sit as SVG text, and the band has to land on the same
 *  pixels now that it is a box: 10px type on a 14px line puts the baseline 10
 *  below the box top (2px of half-leading plus the font's own ascent), so the
 *  box starts that far above the old baseline and nothing moved. */
const CAPTION_HEIGHT = 14;
const CAPTION_ASCENT = 10;

/** The one edge renderer of this lens, keyed by the edge's OWN id (layout.ts,
 *  card 293) so parallel edges both survive.
 *
 *  THE STROKE IS PER EDGE, not per picture. `declared` names the nodes a
 *  script placed; an edge INTO one of them was declared before the run and is
 *  drawn solid, and everything else keeps card 293's dash because it was
 *  reconstructed from the stamps. One run holds both: the spawn of a workflow
 *  is itself a reconstruction, and plain Task children can sit beside it. */
export function WorkflowOverlay({
  laid,
  declared,
}: {
  laid: StateGraphLayout;
  declared?: ReadonlySet<string>;
}) {
  return (
    <svg className="wf-arcs" aria-hidden="true" style={{ overflow: "visible" }}>
      <defs>
        <marker
          id="wf-ar"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M0,1 L9,5 L0,9 z" className="wf-ar-head" />
        </marker>
      </defs>
      {laid.edges.map((e) => (
        <path
          key={e.id}
          d={e.path}
          className="wf-arc"
          {...(declared?.has(e.to) === true ? {} : { strokeDasharray: "7 5" })}
          markerEnd="url(#wf-ar)"
        />
      ))}
      {/* The declared columns' own words, on the layout's own anchors. A
          column nobody named gets nothing — the state graph prints "rank N"
          there because a longest-path column has no other name, but a phase
          column either carries the script's word or carries none.

          CARD 303: each caption is drawn in a box ONE COLUMN WIDE (layout.ts,
          `maxWidth`) and what does not fit is cut with an ellipsis. A phase
          title is whatever the author wrote, and the shipped one already ran
          14.4px into its neighbour at the fit scale the lens opens on; SVG
          text cannot be truncated by a stylesheet, so the caption moved into a
          foreignObject where `text-overflow` works.

          THE CUT IS REAL AND IT TAKES THE DETAIL FIRST. Measured on the
          shipped `Declared workflow` scenario at the fit zoom this lens opens
          on, four of five captions are clipped (scrollWidth 208/186/215/215
          against a 180 box) and every word lost is from the detail half. So
          the words are handed to the PHASE BOX below, which puts them on a
          second line of its own tooltip (`WorkflowNode`, `WfData.detail`) —
          that box is the one the caption names, it is already a hover target,
          and it is sound because a caption only ever survives over a column
          of declared boxes. The caption itself still adds no tooltip: this
          overlay is `pointer-events: none` (card 293, where it swallowed pans
          and node clicks near the graph origin), and a 180x14 strip that
          takes the pointer back is a strip the reader can no longer grab. */}
      {laid.rankLabels.map((l) =>
        l.caption === undefined ? null : (
          <foreignObject
            key={l.rank}
            x={l.x}
            y={l.y - CAPTION_ASCENT}
            width={l.maxWidth}
            height={CAPTION_HEIGHT}
          >
            <div className="wf-ranklabel">
              {l.caption.title}
              {l.caption.detail !== null && <span className="wf-rankdetail">{l.caption.detail}</span>}
            </div>
          </foreignObject>
        ),
      )}
    </svg>
  );
}

/** The dashed rule in words — once — plus the honesty chip on values. */
export function WorkflowLegend({
  lang,
  resolved,
  reported,
  declared = false,
}: {
  lang: Lang;
  resolved: number;
  reported: number;
  /** True when at least one run's columns came from its own declaration. */
  declared?: boolean;
}) {
  return (
    <div className="wf-legend">
      <span className="wf-legend-words">
        {t(lang, declared ? "lab.lens.legendDeclared" : "lab.lens.legend")}
      </span>
      <span
        className="wf-chip mono"
        title={t(lang, declared ? "lab.lens.sourceDeclaredHint" : "lab.lens.sourceRecoveredHint")}
      >
        {t(lang, declared ? "lab.lens.sourceDeclared" : "lab.lens.sourceRecovered")}
      </span>
      <span
        className="wf-chip mono"
        title={t(lang, "lab.lens.reconstructedHint", { n: resolved, m: reported })}
      >
        {t(lang, "lab.lens.reconstructed", { n: resolved, m: reported })}
      </span>
    </div>
  );
}

export function WorkflowLens(props: {
  /** The FULL known timeline (applied + queue) — the reconstruction's source. */
  events: RunEvent[];
  /** The cursor's prefix — the SAME (events, upto) the machine lens follows. */
  applied: RunEvent[];
  /** The one scene fold at the cursor — node states come from here. */
  scene: Scene;
  /** The root's model from the header picker, when the run itself said none. */
  model?: string;
  /** The run-analysis affordance (card 294) — handed in only for an imported
   *  run, so the lens itself stays ignorant of imports and stores. */
  analyze?: ReactNode;
  /** Card 302: what each workflow run in this stream declared about its own
   *  columns, when the reader got a state file. Absent is the normal case and
   *  the honest one — the lens then draws the recovered picture and says so. */
  declared?: WorkflowDeclaration;
}) {
  const lang = useLang();
  const tree = useMemo(() => spawnTree(props.events, props.declared), [props.events, props.declared]);
  const laid = useMemo(() => layoutStateGraph(tree.topo, "horizontal"), [tree]);
  const spawned = useMemo(() => spawnedIn(props.applied), [props.applied]);
  const terminal = useMemo(() => terminalStatesIn(props.applied), [props.applied]);
  // Card 303: a column's caption is cut at the column pitch, and what the cut
  // takes first is the detail. The boxes standing in that column carry those
  // words in their own tooltip, so the reader can get them back — which is
  // sound because a caption only survives over a column of DECLARED boxes:
  // `spawnTree` deletes the word the moment a guessed node stands there too.
  const detailByRank = useMemo(
    () => new Map(laid.rankLabels.map((l) => [l.rank, l.caption?.detail ?? null])),
    [laid],
  );

  const nodes: FlowNode[] = useMemo(
    () =>
      laid.nodes.map((p) => {
        const meta = tree.meta[p.id];
        // A PHASE BOX folds its own state from the agents inside it; every
        // other node answers for itself, exactly as card 293 had it.
        const phase = tree.phaseNodes.has(p.id);
        const state = phase
          ? phaseStateAt(props.scene, spawned, terminal, tree, p.id)
          : nodeStateAt(props.scene, spawned, terminal, p.id, tree.root);
        return {
          id: p.id,
          type: "wfNode",
          position: { x: p.x, y: p.y },
          draggable: false,
          data: {
            // A phase box the DECLARATION did not place is the one holding
            // agents the run's file could not place either. It has no title
            // of its own, and a blank heading would say nothing at all.
            label:
              phase && !tree.declaredNodes.has(p.id)
                ? t(lang, "lab.lens.unplaced")
                : (meta?.label ?? p.label),
            agentType: meta?.agentType ?? null,
            model: meta?.model ?? (p.id === tree.root ? (props.model ?? null) : null),
            state,
            stateLabel: t(lang, `lab.lens.state.${state}`),
            phase,
            detail: detailByRank.get(p.rank) ?? null,
            members: (meta?.members ?? []).map((m) => {
              const own = tree.knownAgents.has(m.agentId)
                ? nodeStateAt(props.scene, spawned, terminal, m.agentId, tree.root)
                : m.declared === "error"
                  ? ("failed" as const)
                  : m.declared;
              return {
                agentId: m.agentId,
                label: m.label,
                model: m.model,
                state: own,
                stateLabel: t(lang, `lab.lens.state.${own}`),
              };
            }),
            w: p.w,
            h: p.h,
          } satisfies WfData,
        };
      }),
    [laid, detailByRank, tree, props.scene, spawned, terminal, props.model, lang],
  );

  return (
    <div className="wf-lens">
      <WorkflowLegend
        lang={lang}
        resolved={tree.resolved}
        reported={tree.reported}
        declared={tree.declared}
      />
      {props.analyze}
      <GraphCanvas
        className="wf-canvas"
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        minZoom={0.1}
        fitViewPadding={0.15}
        suppressContextMenu
      >
        <RefitOnLayout laid={laid} />
        <ViewportPortal>
          <WorkflowOverlay laid={laid} declared={tree.declaredNodes} />
        </ViewportPortal>
      </GraphCanvas>
    </div>
  );
}

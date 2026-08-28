// The Lab's workflow lens (card 293): the run's agents as a topology — the
// spawn tree ranked by time overlap — instead of the machine map. Same
// stepper, same cursor, same scene fold; only the projection changes.
//
// Every edge here is DASHED on purpose: solid means declared before the run
// (the state graph); dashed means reconstructed from what happened. The
// legend says it once in words, and the honesty chip counts what the
// reconstruction actually resolved.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { Node as FlowNode, NodeTypes } from "@xyflow/react";
import type { RunEvent } from "../../events";
import type { Scene } from "../labScene";
import { layoutStateGraph, type StateGraphLayout } from "../../stategraph/layout";
import { GraphCanvas } from "../../reactflow/GraphCanvas";
import { RefitOnLayout } from "../../reactflow/RefitOnLayout";
import { nodeStateAt, spawnedIn, spawnTree, terminalStatesIn } from "../spawnTree";
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

/** The one edge renderer of this lens: every routed path dashed, keyed by
 *  the edge's OWN id (layout.ts, card 293) so parallel edges both survive. */
export function WorkflowOverlay({ laid }: { laid: StateGraphLayout }) {
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
        <path key={e.id} d={e.path} className="wf-arc" strokeDasharray="7 5" markerEnd="url(#wf-ar)" />
      ))}
    </svg>
  );
}

/** The dashed rule in words — once — plus the honesty chip on values. */
export function WorkflowLegend({
  lang,
  resolved,
  reported,
}: {
  lang: Lang;
  resolved: number;
  reported: number;
}) {
  return (
    <div className="wf-legend">
      <span className="wf-legend-words">{t(lang, "lab.lens.legend")}</span>
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
}) {
  const lang = useLang();
  const tree = useMemo(() => spawnTree(props.events), [props.events]);
  const laid = useMemo(() => layoutStateGraph(tree.topo, "horizontal"), [tree]);
  const spawned = useMemo(() => spawnedIn(props.applied), [props.applied]);
  const terminal = useMemo(() => terminalStatesIn(props.applied), [props.applied]);

  const nodes: FlowNode[] = useMemo(
    () =>
      laid.nodes.map((p) => {
        const meta = tree.meta[p.id];
        const state = nodeStateAt(props.scene, spawned, terminal, p.id, tree.root);
        return {
          id: p.id,
          type: "wfNode",
          position: { x: p.x, y: p.y },
          draggable: false,
          data: {
            label: meta?.label ?? p.label,
            agentType: meta?.agentType ?? null,
            model: meta?.model ?? (p.id === tree.root ? (props.model ?? null) : null),
            state,
            stateLabel: t(lang, `lab.lens.state.${state}`),
            w: p.w,
            h: p.h,
          } satisfies WfData,
        };
      }),
    [laid, tree, props.scene, spawned, terminal, props.model, lang],
  );

  return (
    <div className="wf-lens">
      <WorkflowLegend lang={lang} resolved={tree.resolved} reported={tree.reported} />
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
          <WorkflowOverlay laid={laid} />
        </ViewportPortal>
      </GraphCanvas>
    </div>
  );
}

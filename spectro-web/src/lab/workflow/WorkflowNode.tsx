// The workflow lens's small topology card (card 293), in its own module.
//
// React Flow takes this component through the lens's node-type map, never
// through JSX — which is exactly the shape the component-reach drift gate
// cannot tell from an orphan while card and lens share one file. Split out,
// the lens's import IS the attachment, and the gate can see it.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { WorkflowNodeState } from "../spawnTree";

export interface WfData extends Record<string, unknown> {
  label: string;
  agentType: string | null;
  model: string | null;
  state: WorkflowNodeState;
  /** Pre-translated state word — the card itself stays language-free. */
  stateLabel: string;
  w: number;
  h: number;
}

/** The small topology card: label, type, model if known, state. Deliberately
 *  NOT the machine view's 408×560 worker envelope — this is the topology
 *  view, and the box matches the layout's own node cell. */
export function WorkflowNode({ data }: NodeProps) {
  const d = data as WfData;
  const meta = [d.agentType, d.model, d.stateLabel].filter((p): p is string => p !== null && p !== "");
  return (
    <div
      className={`wf-node wf-node--${d.state}`}
      style={{ width: d.w, height: d.h }}
      title={`${d.label} · ${d.stateLabel}`}
    >
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <span className="wf-node-label">{d.label}</span>
      <span className="wf-node-meta mono">{meta.join(" · ")}</span>
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

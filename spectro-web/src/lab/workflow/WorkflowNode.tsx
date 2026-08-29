// The workflow lens's node card (card 293), in its own module.
//
// React Flow takes this component through the lens's node-type map, never
// through JSX — which is exactly the shape the component-reach drift gate
// cannot tell from an orphan while card and lens share one file. Split out,
// the lens's import IS the attachment, and the gate can see it.
//
// CARD 302 gave it a second form. A node that only NAMES an agent stays the
// small card it always was. A node that IS A PHASE holds the agents that ran
// inside it — label, state and model per row — because the phase is the node
// now and a fan-out has to stay readable: "survey holds five".

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { WorkflowNodeState } from "../spawnTree";

/** One agent row inside a phase box. */
export interface WfMember {
  agentId: string;
  label: string;
  model: string | null;
  state: WorkflowNodeState;
  /** Pre-translated — the card itself stays language-free. */
  stateLabel: string;
}

export interface WfData extends Record<string, unknown> {
  label: string;
  agentType: string | null;
  model: string | null;
  state: WorkflowNodeState;
  /** Pre-translated state word — the card itself stays language-free. */
  stateLabel: string;
  /** True for a declared phase's box. It renders its members and keeps its
   *  label as a heading; false is card 293's small card, unchanged. */
  phase: boolean;
  /** The agents inside this phase, in the run's own order. Empty for a phase
   *  the run never entered — which is drawn, and dim, on purpose. */
  members: WfMember[];
  w: number;
  h: number;
}

/** The card: label, type, model if known, state — and, for a phase, the
 *  agents it holds. State colours ride borders, never fills. */
export function WorkflowNode({ data }: NodeProps) {
  const d = data as WfData;
  if (d.phase) {
    return (
      <div
        className={`wf-node wf-node--phase wf-node--${d.state}`}
        style={{ width: d.w, height: d.h }}
        title={`${d.label} · ${d.stateLabel}`}
      >
        <Handle type="target" position={Position.Left} className="wf-handle" />
        <span className="wf-node-label">{d.label}</span>
        <ul className="wf-agents">
          {d.members.map((m) => (
            <li
              key={m.agentId}
              className={`wf-agent wf-agent--${m.state}`}
              title={`${m.label} · ${m.stateLabel}`}
            >
              <span className="wf-agent-label">{m.label}</span>
              {m.model !== null && m.model !== "" && <span className="wf-agent-meta mono">{m.model}</span>}
            </li>
          ))}
        </ul>
        <Handle type="source" position={Position.Right} className="wf-handle" />
      </div>
    );
  }
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

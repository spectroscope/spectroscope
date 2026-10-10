// Card 483: the editor's boxes. Each box carries two hidden anchor handles
// that only hold the routed edges, a drop handle as large as the box so a drag
// lands anywhere on it, and the visible source handles a user drags from: `out`
// on a step, one per outcome on a decision, none on an end.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import type { PbNodeData } from "./toFlow";

/** The two handles every drawn edge hangs on; nobody connects through them. */
function Anchors() {
  return (
    <>
      <Handle
        type="target"
        id="anchor-in"
        position={Position.Left}
        isConnectable={false}
        className="sg-handle"
      />
      <Handle
        type="source"
        id="anchor-out"
        position={Position.Right}
        isConnectable={false}
        className="sg-handle"
      />
    </>
  );
}

/** The target as large as the box. A drag ends on it; none starts from it. */
function Drop() {
  return (
    <Handle type="target" id="in" position={Position.Left} isConnectableStart={false} className="pbe-drop" />
  );
}

function Box({
  kind,
  data,
  selected,
  children,
}: {
  kind: string;
  data: PbNodeData;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`pbe-node pbe-node--${kind}${selected ? " is-selected" : ""}`}
      style={{ width: data.placed.w, height: data.placed.h }}
      data-node={data.placed.id}
    >
      {children}
    </div>
  );
}

function StepNode({ data, selected }: NodeProps) {
  const d = data as PbNodeData;
  const lang = useLang();
  const step = d.node?.kind === "step" ? d.node : null;
  return (
    <Box kind="step" data={d} selected={selected}>
      <Anchors />
      <Drop />
      <div className="pbe-name" title={step?.name}>
        {step?.name}
      </div>
      <div className="pbe-meta">{step?.model ?? ""}</div>
      <div className="pbe-meta">{t(lang, step?.performer === "child" ? "pb.child" : "pb.chat")}</div>
      <Handle type="source" id="out" position={Position.Right} className="pbe-out" />
    </Box>
  );
}

function DecisionNode({ data, selected }: NodeProps) {
  const d = data as PbNodeData;
  const lang = useLang();
  const decision = d.node?.kind === "decision" ? d.node : null;
  const n = d.outcomes.length;
  return (
    <Box kind="decision" data={d} selected={selected}>
      <Anchors />
      <Drop />
      <svg className="pbe-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="pbe-decision-text">
        <div className="pbe-name" title={decision?.name}>
          {decision?.name}
        </div>
        {decision?.max_rounds !== undefined && (
          <div className="pbe-meta">{t(lang, "pb.rounds", { n: decision.max_rounds })}</div>
        )}
      </div>
      {d.outcomes.map((outcome, i) => (
        <Handle
          key={outcome}
          type="source"
          id={outcome}
          position={Position.Right}
          className="pbe-out pbe-out--outcome"
          title={outcome}
          style={{ top: `${((i + 1) / (n + 1)) * 100}%` }}
        />
      ))}
    </Box>
  );
}

function EndNode({ data, selected }: NodeProps) {
  const d = data as PbNodeData;
  const end = d.node?.kind === "end" ? d.node : null;
  return (
    <Box kind="end" data={d} selected={selected}>
      <Anchors />
      <Drop />
      <div className="pbe-name">{end?.result}</div>
    </Box>
  );
}

function StartNode({ data }: NodeProps) {
  const d = data as PbNodeData;
  const lang = useLang();
  return (
    <Box kind="start" data={d} selected={false}>
      <Anchors />
      <div className="pbe-name">{t(lang, "pb.start")}</div>
    </Box>
  );
}

function GhostNode({ data }: NodeProps) {
  const d = data as PbNodeData;
  const lang = useLang();
  return (
    <Box kind="ghost" data={d} selected={false}>
      <Anchors />
      <div className="pbe-name" title={d.name}>
        {d.name}
      </div>
      <div className="pbe-meta">
        {t(lang, d.ghost === "duplicate" ? "pbe.ghost.duplicate" : "pbe.ghost.missing")}
      </div>
    </Box>
  );
}

export const PB_NODE_TYPES = {
  pbStep: StepNode,
  pbDecision: DecisionNode,
  pbEnd: EndNode,
  pbStart: StartNode,
  pbGhost: GhostNode,
};

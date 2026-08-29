// The eight invisible connection points every card on the flow map carries.
//
// In its own module since card 306, and the extraction is not tidying. The box
// that card adds lives in `WorkflowBoxNode.tsx` (React Flow reaches it through
// `nodeTypes`, and the component-reach gate cannot tell that from an orphan
// while it shares a file with the map). It needs the same handles, and
// importing them from `nodes.tsx` would close a cycle — `nodes.tsx` imports
// the box. So the set lives beside both instead of being written twice: one
// card missing one side is a dropped edge and a console warning, never an
// error, and that is how a rail goes missing without anything turning red.

import { Fragment } from "react";
import { Handle, Position } from "@xyflow/react";

const SIDES = [
  ["l", Position.Left],
  ["r", Position.Right],
  ["t", Position.Top],
  ["b", Position.Bottom],
] as const;

/** Eight invisible handles (source+target per side); edges pick by id. */
export function Handles() {
  return (
    <>
      {SIDES.map(([k, pos]) => (
        <Fragment key={k}>
          <Handle id={`${k}s`} type="source" position={pos} isConnectable={false} />
          <Handle id={`${k}t`} type="target" position={pos} isConnectable={false} />
        </Fragment>
      ))}
    </>
  );
}

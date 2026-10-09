// Card 483: an arrow drawn on the path the layout routed. React Flow's own
// coordinates are ignored, as PacketEdge in the lab does, so there is one
// renderer for edges and one route. BaseEdge adds the 20 px hit path that
// makes a thin arrow easy to click and select.

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { PbEdgeData } from "./toFlow";

/** The arrowhead's marker id; EditorCanvas draws the marker once. */
export const ARROWHEAD = "pbe-arrowhead";

export function ArrowEdge({ id, data, selected }: EdgeProps) {
  const d = data as PbEdgeData | undefined;
  if (d === undefined) return null;
  const className =
    "pbe-arrow" +
    (d.back ? " pbe-arrow--back" : "") +
    (d.dangling ? " pbe-arrow--dangling" : "") +
    (selected ? " is-selected" : "");
  return (
    <>
      <BaseEdge
        id={id}
        path={d.path}
        className={className}
        markerEnd={`url(#${ARROWHEAD})`}
        interactionWidth={20}
      />
      {d.label !== null && (
        <EdgeLabelRenderer>
          <div
            className={`pbe-label${selected ? " is-selected" : ""}${d.dangling ? " pbe-label--dangling" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${d.label.x}px, ${d.label.y}px)` }}
          >
            {d.label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

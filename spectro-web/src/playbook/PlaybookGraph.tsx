// Card 481, changed by card 483 (Task 11): a playbook drawn by a renderer of
// its own over the state graph's layout engine. The graph takes the editor's
// document and draws it through the editor's projection, so what the read view
// shows is what the editor lays out: every end is a box of its own, an arrow
// whose endpoint is not in the document ends in a marked ghost box instead of
// being dropped, and each outcome label comes from placeLabels, one per arrow.
//
// This file paints what the state graph's card cannot hold: the model choice
// and the performer of a step, the round ceiling of a decision, and the
// outcome on each arrow.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { layoutStateGraph, type PlacedNode } from "../stategraph/layout";
import type { DocNode, PlaybookDoc } from "./editor/doc";
import { placeLabels } from "./editor/labels";
import { assertJoined, project, START } from "./editor/projection";

const PAD = 24;

/** A label cut to a length the card holds; the full text rides in the node's title. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function PlaybookGraph({ doc }: { doc: PlaybookDoc }) {
  const lang = useLang();
  const projection = project(doc);
  const laid = layoutStateGraph(projection.topo, "horizontal");
  assertJoined(projection, laid);
  const labels = placeLabels(doc, projection, laid);
  const labelOf = new Map(labels.map((l) => [l.edgeIndex, l]));

  const { x0, y0, x1, y1 } = laid.bounds;
  const w = x1 - x0 + 2 * PAD;
  const h = y1 - y0 + 2 * PAD;

  const card = (n: PlacedNode) => {
    const ghost = projection.ghosts.get(n.id);
    if (ghost !== undefined) {
      return (
        <g className="pb-node pb-node--ghost" data-node={n.id} key={n.id}>
          <title>{ghost.name}</title>
          <rect className="pb-ghost" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
          <text className="pb-label" x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
            {clip(ghost.name, 14)}
          </text>
        </g>
      );
    }
    if (n.id === START) {
      return (
        <g className="pb-node pb-node--terminal" data-node={n.id} key={n.id}>
          <rect className="pb-terminal" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
          <text className="pb-label" x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
            {t(lang, "pb.start")}
          </text>
        </g>
      );
    }
    const node: DocNode | undefined = doc.nodes[projection.nodeIndex.get(n.id) ?? -1];
    if (node?.kind === "step") {
      return (
        <g className="pb-node pb-node--step" data-node={n.id} key={n.id}>
          <title>{node.name}</title>
          <rect className="pb-step" x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
          <text className="pb-label" x={n.x + 10} y={n.y + 22}>
            {clip(node.name, 22)}
          </text>
          <text className="pb-meta" x={n.x + 10} y={n.y + 39}>
            {clip(node.model ?? "", 26)}
          </text>
          <text className="pb-meta" x={n.x + 10} y={n.y + 54}>
            {t(lang, node.performer === "child" ? "pb.child" : "pb.chat")}
          </text>
        </g>
      );
    }
    if (node?.kind === "decision") {
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      const points = `${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`;
      const rounds = node.max_rounds;
      return (
        <g className="pb-node pb-node--decision" data-node={n.id} key={n.id}>
          <title>{node.name}</title>
          <polygon className="pb-decision" points={points} />
          <text className="pb-label" x={cx} y={rounds !== undefined ? cy - 2 : cy + 4} textAnchor="middle">
            {clip(node.name, 14)}
          </text>
          {rounds !== undefined && (
            <text className="pb-rounds" x={cx} y={cy + 12} textAnchor="middle">
              {t(lang, "pb.rounds", { n: rounds })}
            </text>
          )}
        </g>
      );
    }
    return (
      <g className="pb-node pb-node--end" data-node={n.id} key={n.id}>
        <title>{node?.kind === "end" ? node.result : n.label}</title>
        <rect className="pb-end" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
        <text className="pb-label" x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
          {clip(node?.kind === "end" ? node.result : n.label, 14)}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="pb-graph"
      role="img"
      aria-label={doc.name}
      viewBox={`${x0 - PAD} ${y0 - PAD} ${w} ${h}`}
      width={w}
      height={h}
    >
      <defs>
        <marker
          id="pb-arrow"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path className="pb-arrowhead" d="M0,1 L9,5 L0,9 z" />
        </marker>
        <marker
          id="pb-arrow-back"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path className="pb-arrowhead pb-arrowhead--back" d="M0,1 L9,5 L0,9 z" />
        </marker>
      </defs>
      {laid.edges.map((e, k) => {
        const dangling = projection.ghosts.has(e.from) || projection.ghosts.has(e.to);
        const label = labelOf.get(k);
        const className =
          "pb-edge" +
          (e.kind === "conditional" ? " pb-edge--cond" : "") +
          (e.back ? " pb-edge--back" : "") +
          (dangling ? " pb-edge--dangling" : "");
        return (
          <g className="pb-edge-g" data-from={e.from} data-to={e.to} key={e.id}>
            <path
              className={className}
              d={e.path}
              markerEnd={`url(#${e.back ? "pb-arrow-back" : "pb-arrow"})`}
            />
            {label !== undefined && (
              <text className="pb-outcome" x={label.x} y={label.y - 4} textAnchor="middle">
                {label.text}
              </text>
            )}
          </g>
        );
      })}
      {laid.nodes.map(card)}
    </svg>
  );
}

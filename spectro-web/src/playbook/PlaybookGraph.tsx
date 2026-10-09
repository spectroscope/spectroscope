// Card 481: a playbook drawn by a renderer of its own over the state graph's
// layout engine. The engine places the boxes and routes the arrows, loops kept
// as loops; this file states a card size per node kind and paints what the
// state graph's card cannot hold: the model choice and the performer of a
// step, the round ceiling of a decision, and the outcome on each arrow.
//
// The server folds every end into `__end__` and names a decision's edges by
// the decision, not by the outcome, so the outcome comes from the playbook's
// own arrows: the edges out of a decision follow its arrows in file order.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { toWebTopology, type LoadedPlaybook, type PlaybookNode } from "../state/playbooks";
import { layoutStateGraph, type NodeSize, type PlacedNode } from "../stategraph/layout";

/** A step card and a decision diamond, in pixels. Start and end keep the engine's cell. */
const STEP: NodeSize = { w: 180, h: 64 };
const DECISION: NodeSize = { w: 140, h: 64 };
const PAD = 24;

/** A label cut to a length the card holds; the full text rides in the node's title. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The outcome each drawn edge carries, keyed by the edge's index in the topology. */
function outcomesOf(loaded: LoadedPlaybook): (string | null)[] {
  const p = loaded.playbook;
  const topo = loaded.topology;
  if (p === null || topo === null) return [];
  const decisions = new Set(p.nodes.filter((n) => n.kind === "decision").map((n) => n.id));
  const seen = new Map<string, number>();
  return topo.edges.map((e) => {
    if (!decisions.has(e.from)) return null;
    const k = seen.get(e.from) ?? 0;
    seen.set(e.from, k + 1);
    return p.arrows.filter((a) => a.from === e.from)[k]?.on ?? null;
  });
}

export function PlaybookGraph({ loaded }: { loaded: LoadedPlaybook }) {
  const lang = useLang();
  const byId = new Map<string, PlaybookNode>((loaded.playbook?.nodes ?? []).map((n) => [n.id, n]));
  const topology = toWebTopology(loaded);
  const sizes = new Map<string, NodeSize>();
  for (const n of topology.nodes) {
    const kind = byId.get(n.id)?.kind;
    if (kind === "step") sizes.set(n.id, STEP);
    else if (kind === "decision") sizes.set(n.id, DECISION);
  }
  const laid = layoutStateGraph({ ...topology, sizes }, "horizontal");

  // The engine drops an edge whose end is unknown; the outcomes are counted
  // over the same surviving edges so each label stays on its own arrow.
  const known = new Set(topology.nodes.map((n) => n.id));
  const outcomes = outcomesOf(loaded).filter((_, i) => {
    const e = topology.edges[i];
    return known.has(e.from) && known.has(e.to);
  });
  const rankOf = new Map(laid.nodes.map((n) => [n.id, n.rank]));
  // Parallel arrows between one pair share a route; their outcomes share one label.
  const labelOfPair = new Map<string, string[]>();
  laid.edges.forEach((e, i) => {
    const on = outcomes[i];
    if (on === null || on === undefined) return;
    const pair = `${e.from}|${e.to}`;
    labelOfPair.set(pair, [...(labelOfPair.get(pair) ?? []), on]);
  });
  const labelled = new Set<string>();

  const { x0, y0, x1, y1 } = laid.bounds;
  const w = x1 - x0 + 2 * PAD;
  const h = y1 - y0 + 2 * PAD;

  const card = (n: PlacedNode) => {
    const node = byId.get(n.id);
    if (node?.kind === "step") {
      const choice = node.model ?? "";
      return (
        <g className="pb-node pb-node--step" data-node={n.id} key={n.id}>
          <title>{node.name}</title>
          <rect className="pb-step" x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
          <text className="pb-label" x={n.x + 10} y={n.y + 22}>
            {clip(node.name, 22)}
          </text>
          <text className="pb-meta" x={n.x + 10} y={n.y + 39}>
            {clip(choice, 26)}
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
      return (
        <g className="pb-node pb-node--decision" data-node={n.id} key={n.id}>
          <title>{node.name}</title>
          <polygon className="pb-decision" points={points} />
          <text className="pb-label" x={cx} y={node.maxRounds !== null ? cy - 2 : cy + 4} textAnchor="middle">
            {clip(node.name, 14)}
          </text>
          {node.maxRounds !== null && (
            <text className="pb-rounds" x={cx} y={cy + 12} textAnchor="middle">
              {t(lang, "pb.rounds", { n: node.maxRounds })}
            </text>
          )}
        </g>
      );
    }
    const word =
      n.id === "__start__" ? t(lang, "pb.start") : n.id === "__end__" ? t(lang, "pb.end") : n.label;
    return (
      <g className="pb-node pb-node--terminal" data-node={n.id} key={n.id}>
        <rect className="pb-terminal" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
        <text className="pb-label" x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle">
          {word}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="pb-graph"
      role="img"
      aria-label={loaded.playbook?.name ?? ""}
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
      {laid.edges.map((e) => {
        // An arrow into an earlier column closes a loop: a decision's retry, or
        // the step that answers a review going back to it.
        const back = (rankOf.get(e.to) ?? 0) < (rankOf.get(e.from) ?? 0);
        const pair = `${e.from}|${e.to}`;
        const words = labelled.has(pair) ? undefined : labelOfPair.get(pair);
        labelled.add(pair);
        const className = `pb-edge${e.kind === "conditional" ? " pb-edge--cond" : ""}${back ? " pb-edge--back" : ""}`;
        return (
          <g className="pb-edge-g" data-from={e.from} data-to={e.to} key={e.id}>
            <path
              className={className}
              d={e.path}
              markerEnd={`url(#${back ? "pb-arrow-back" : "pb-arrow"})`}
            />
            {words !== undefined && (
              <text className="pb-outcome" x={e.labelX} y={e.labelY - 4} textAnchor="middle">
                {words.join(" · ")}
              </text>
            )}
          </g>
        );
      })}
      {laid.nodes.map(card)}
    </svg>
  );
}

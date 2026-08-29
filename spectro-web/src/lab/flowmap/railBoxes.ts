// The live obstacle set for the rails (card 287): every card's box, recomputed
// from the rendered nodes so a dragged card re-routes its rails. Zones are
// excluded — they are the drawn frames, not cards. A canvas that provides no
// boxes (the fleet machine room, tests) gets the helper's own default trunk.
//
// CARD 306 moved the derivation itself out of FlowMap and into this file. It
// was one expression in a `useMemo`, and it read `n.position` as a WORLD
// coordinate — true for the map's whole life, and false the moment the
// workflow box made its member agents React Flow children. A rail to a member
// would have been routed to its position INSIDE its box, which is a point
// several hundred px away from the card it is drawn from, and nothing would
// have said so. Out here it goes through `worldBoxes` and can be bitten.
import { createContext } from "react";
import type { RailBox } from "./railRoute";
import { worldBoxes } from "./worldBox";
import type { RowsPref } from "./workerGrid";

export const RailBoxes = createContext<ReadonlyArray<RailBox>>([]);

/** A node as this derivation reads it — what React Flow hands back. */
export interface RenderedNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentId?: string;
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
}

/** What a card is assumed to be before anything has measured it. */
const DEFAULT_W = 200;
const DEFAULT_H = 100;

/**
 * The rendered cards as WORLD rectangles, zones dropped.
 *
 * @param nodes what the canvas currently holds
 */
export function railBoxesFrom(nodes: readonly RenderedNode[]): RailBox[] {
  const world = worldBoxes(nodes);
  return nodes
    .filter((n) => n.type !== "zone")
    .map((n) => {
      const at = world.get(n.id) ?? n.position;
      return {
        id: n.id,
        x: at.x,
        y: at.y,
        w: (n.measured?.width ?? n.width ?? DEFAULT_W) as number,
        h: (n.measured?.height ?? n.height ?? DEFAULT_H) as number,
      };
    });
}

/**
 * The string that names the seating the rendered nodes came from.
 *
 * Compact and expanded are two different seatings, so switching the card view
 * IS a re-layout. Since card 306 a single BOX's switch is one too: its members
 * change size, so the box changes size, so everything the box pushed aside
 * moves. Leaving the box switch out would have made this key claim a seating
 * the map is not in — the cards would keep the seats of the other one.
 *
 * @param expandAll the map-wide switch
 * @param paneAspect the measured pane, which drives the expanded row count
 * @param rowsPref the reader's row choice
 * @param boxSwitch `boxSwitchKey` of the boxes whose own switch was thrown
 */
export function seatingKey(
  expandAll: boolean,
  paneAspect: number | null,
  rowsPref: RowsPref,
  boxSwitch: string,
): string {
  return `${expandAll}:${paneAspect}:${rowsPref}:${boxSwitch}`;
}

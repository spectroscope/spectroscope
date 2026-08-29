// The rail + the coral "packet". A custom React Flow edge draws the rail;
// when it is the active leg (leading to the current focus) it turns coral,
// gains a flowing dash, and one or two comet dots ride the EXACT path via SVG
// <animateMotion>/<mpath> — the modern, GPU-friendly analogue of the SVG map's
// static packet. Reduced motion is honoured in CSS (comets hidden, dash
// frozen).
//
// RIGHT-ANGLED since card 287: the path is the canvas package's own
// smooth-step, with the ONE number the helper leaves open — where the turn
// happens — chosen by railRoute's obstacle scorer against the live card boxes
// (RailBoxes). No boxes provided (the fleet machine room, tests) → the
// helper's own default trunk, still right-angled. The lane offset comes from
// an ID HASH, never an index into the edges array: an index renumbers the
// moment a station rail appears, and a trunk that jumps sideways mid-run is
// worse than an overlap.

import { useContext } from "react";
import { getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { RailBoxes } from "./railBoxes";
import { RAIL_STUB, splitAxis, trunkFor, type RailEnd, type Side } from "./railRoute";

/** -20 | -10 | 0 | +10 | +20, stable per edge id. Five lanes, not three:
 *  since card 295 every worker keeps a rail to every station, so up to seven
 *  rails converge on one station handle and three lanes put most of them on
 *  top of each other. */
export function railLane(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 5) - 2) * 10;
}

export function PacketEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const boxes = useContext(RailBoxes);
  // The engine's handle sides are the first letter of the Position enum value
  // ("left" | "right" | "top" | "bottom") — the same letters railRoute names.
  const from: RailEnd = { x: sourceX, y: sourceY, side: sourcePosition[0] as Side };
  const to: RailEnd = { x: targetX, y: targetY, side: targetPosition[0] as Side };
  const trunk = boxes.length > 0 ? trunkFor(from, to, [...boxes], railLane(id)) : null;
  // Guard against handing the helper a centre it would not read (splitAxis
  // documents which one moves the trunk) — a wrong centre is silently ignored
  // and the rail routes on the default while we believe it is steered.
  const steer =
    trunk === null || trunk.axis !== splitAxis(from, to)
      ? {}
      : trunk.axis === "x"
        ? { centerX: trunk.at }
        : { centerY: trunk.at };
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: RAIL_STUB,
    ...steer,
  });
  const d = (data ?? {}) as {
    active?: boolean;
    net?: boolean;
    err?: boolean;
    dim?: boolean;
    flow?: boolean;
    /** A subagent's own leg — painted in the worker accent, so a lit station
     *  says WHO is on it before the chip is read (card 295). */
    worker?: boolean;
  };

  const cls = [
    "pf-rail",
    d.net ? "pf-rail--net" : "",
    d.active ? "pf-rail--active" : "",
    d.active && d.flow ? "pf-rail--flow" : "",
    d.active && d.worker ? "pf-rail--worker" : "",
    d.err ? "pf-rail--err" : "",
  ]
    .join(" ")
    .trim();

  const pathId = `p-${id}`;
  const cometCls = d.err ? "pf-comet pf-comet--err" : d.worker ? "pf-comet pf-comet--worker" : "pf-comet";

  return (
    <>
      <path id={pathId} className={cls} d={path} style={d.dim ? { opacity: 0.4 } : undefined} />
      {d.active && (
        <>
          <circle className="pf-comet-glow" r={7}>
            <animateMotion dur="1.15s" repeatCount="indefinite" rotate="auto">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          <circle className={cometCls} r={3.6}>
            <animateMotion dur="1.15s" repeatCount="indefinite" rotate="auto">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          <circle className={cometCls} r={2.6} opacity={0.7}>
            <animateMotion dur="1.15s" begin="0.55s" repeatCount="indefinite" rotate="auto">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
        </>
      )}
    </>
  );
}

export const edgeTypes = { rail: PacketEdge };

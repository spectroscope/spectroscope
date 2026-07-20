// The rail + the coral "packet". A custom React Flow edge draws the bezier rail;
// when it is the active leg (leading to the current focus) it turns coral, gains a
// flowing dash, and one or two comet dots ride the EXACT path via SVG
// <animateMotion>/<mpath> — the modern, GPU-friendly analogue of the SVG map's
// static packet. Reduced motion is honoured in CSS (comets hidden, dash frozen).

import { getBezierPath, type EdgeProps } from "@xyflow/react";

export function PacketEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
}: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const d = (data ?? {}) as { active?: boolean; net?: boolean; err?: boolean; dim?: boolean; flow?: boolean };

  const cls = [
    "pf-rail",
    d.net ? "pf-rail--net" : "",
    d.active ? "pf-rail--active" : "",
    d.active && d.flow ? "pf-rail--flow" : "",
    d.err ? "pf-rail--err" : "",
  ].join(" ").trim();

  const pathId = `p-${id}`;
  const cometCls = d.err ? "pf-comet pf-comet--err" : "pf-comet";

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

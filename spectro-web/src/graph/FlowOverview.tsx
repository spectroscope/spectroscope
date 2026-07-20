// The flow view of the Graph tab — a BPMN-like minimap of the whole session.
// Activities stack on the main spine; a subagent wave renders as a parallel
// split into side-by-side branch columns that join back. In replay mode the
// cursor is mirrored live (the activity containing event n-1 glows) and
// clicking any activity seeks the timeline to its first event. Ported from
// the LLM_Simulator's OverviewPane; keep the two in sync.

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../events";
import { buildOverview, activityAt, type Activity, type OverviewNode } from "./overviewModel";

const PAD = 10;        // outer padding
const MIN_INNER = 300; // never lay out narrower than the drawer minimum
const MAX_INNER = 720; // a reading width — the pane centers wider canvases
const ACT_H = 26;      // activity height
const V_GAP = 8;       // vertical gap between activities
const BAR_H = 3;       // split/join bar height
const BR_GAP = 6;      // gap between branch columns
const BR_HEAD = 14;    // branch header (agent id) height
const CHAR_PX = 6.2;   // ≈ width of one 10px ui-monospace character

interface PlacedAct { a: Activity; x: number; y: number; w: number; }
interface PlacedBar { y: number; x: number; w: number; blockId: string; blockFrom: number; }
interface PlacedHead { x: number; y: number; w: number; text: string; blockFrom: number; }

interface Layout {
  acts: PlacedAct[];
  bars: PlacedBar[];
  heads: PlacedHead[];
  width: number;
  height: number;
  cx: number;
}

/** Lay the flow out into the ACTUAL pane width — widen the pane and every
 *  box (and its visible text) widens with it, up to a reading width. */
function layout(nodes: OverviewNode[], paneW: number): Layout {
  const inner = Math.min(MAX_INNER,
    Math.max(MIN_INNER, paneW - PAD * 2 - 8 /* scrollbar allowance */));
  const spineW = inner;
  const width = inner + PAD * 2;
  const cx = width / 2;

  const acts: PlacedAct[] = [];
  const bars: PlacedBar[] = [];
  const heads: PlacedHead[] = [];
  let y = PAD;

  for (const nd of nodes) {
    if (nd.t === "activity") {
      acts.push({ a: nd.a, x: cx - spineW / 2, y, w: spineW });
      y += ACT_H + V_GAP;
      continue;
    }
    // parallel block: split bar, branch columns sharing the full width, join bar
    const n = Math.max(1, nd.branches.length);
    const brW = Math.max(90, (inner - (n - 1) * BR_GAP) / n);
    const total = n * brW + (n - 1) * BR_GAP;
    const left = cx - total / 2;
    bars.push({ y, x: left, w: total, blockId: nd.id, blockFrom: nd.from });
    y += BAR_H + V_GAP;
    let maxH = 0;
    nd.branches.forEach((b, bi) => {
      const bx = left + bi * (brW + BR_GAP);
      heads.push({ x: bx, y, w: brW, text: b.label ? `${b.agentId} · ${b.label}` : b.agentId, blockFrom: nd.from });
      let by = y + BR_HEAD;
      for (const a of b.activities) {
        acts.push({ a, x: bx, y: by, w: brW });
        by += ACT_H + V_GAP;
      }
      maxH = Math.max(maxH, by - y);
    });
    y += Math.max(maxH, BR_HEAD) + V_GAP / 2;
    bars.push({ y, x: left, w: total, blockId: nd.id, blockFrom: nd.from });
    y += BAR_H + V_GAP;
  }

  return { acts, bars, heads, width, height: y + PAD, cx };
}

/** Truncate to what actually fits the box at ~6.2px per mono character. */
const fit = (s: string, boxW: number) => {
  const max = Math.max(4, Math.floor((boxW - 14) / CHAR_PX));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

function actClass(a: Activity, currentId: string | null, n: number): string {
  const cls = ["pf-ov__act", `is-${a.kind}`];
  if (a.id === currentId) cls.push("is-current");
  else if (a.to < n) cls.push("is-applied");
  else if (a.from >= n) cls.push("is-future");
  if (a.isError) cls.push("is-error");
  return cls.join(" ");
}

export interface FlowOverviewProps {
  /** The FULL raw event array of the shown session. */
  events: RunEvent[];
  /** Cursor: how many events are applied. Live mode passes events.length. */
  n: number;
  /** Replay only: seek the timeline to an event index (1-based cursor). */
  onSeek?: (n: number) => void;
}

export function FlowOverview({ events, n, onSeek }: FlowOverviewProps) {
  const nodes = useMemo(() => buildOverview(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  // Track the pane's real width so the layout and the visible text grow
  // when the panel gets wider.
  const [paneW, setPaneW] = useState(MIN_INNER + PAD * 2);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setPaneW(el.clientWidth || MIN_INNER + PAD * 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lay = useMemo(() => layout(nodes, paneW), [nodes, paneW]);
  const currentId = useMemo(() => activityAt(nodes, n), [nodes, n]);

  // Keep the live cursor in view while playing/stepping/streaming.
  useEffect(() => {
    if (!currentId) return;
    const el = scroller.current?.querySelector(`[data-oid="${currentId}"]`);
    (el as { scrollIntoView?: (o: object) => void } | null)?.scrollIntoView?.({ block: "nearest" });
  }, [currentId]);

  const seek = (to: number) => onSeek?.(to);

  return (
    <div className="graph-ov pf-ov" ref={scroller}>
      <svg width={lay.width} height={lay.height} role="img">
        {lay.bars.map((b, i) => (
          <rect
            key={`bar${i}`}
            data-oid={b.blockId}
            className={`pf-ov__bar ${b.blockId === currentId ? "is-current" : ""}`}
            x={b.x} y={b.y} width={b.w} height={BAR_H} rx={1.5}
            onClick={() => seek(b.blockFrom + 1)}
          />
        ))}
        {lay.heads.map((h, i) => (
          <text key={`head${i}`} className="pf-ov__branch" x={h.x + h.w / 2} y={h.y + BR_HEAD - 4} textAnchor="middle">
            {fit(h.text, h.w)}
          </text>
        ))}
        {lay.acts.map(({ a, x, y, w }) => (
          <g
            key={a.id}
            data-oid={a.id}
            className={actClass(a, currentId, n) + (onSeek ? "" : " is-static")}
            role={onSeek ? "button" : undefined}
            tabIndex={onSeek ? 0 : undefined}
            aria-label={a.label}
            onClick={() => seek(a.from + 1)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") seek(a.from + 1); }}
          >
            <title>{`${a.label} · ${a.from + 1}–${a.to + 1}`}</title>
            <rect x={x} y={y} width={w} height={ACT_H} rx={6} />
            <text x={x + w / 2} y={y + ACT_H / 2 + 3.5} textAnchor="middle">
              {fit(a.label, w)}
            </text>
            {a.gate && (
              <circle className={`pf-ov__gate is-${a.gate}`} cx={x + w - 7} cy={y + 7} r={3.5} />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

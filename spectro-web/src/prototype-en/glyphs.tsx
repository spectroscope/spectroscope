// Animated node glyphs, all pure SVG on design tokens (reskin across genomes,
// transparent, reduced-motion aware). Each is calm when idle and comes alive when
// its node is `active`:
//   Keyboard  — the User node: keys ripple as if someone is typing the prompt.
//   Router    — the Netz node: blinking activity LEDs + routing signal waves.
//   AluChip   — the MCP-Server node: a chip whose cells flicker like an ALU crunching.

import type { CSSProperties } from "react";

const d = (v: number): CSSProperties => ({ animationDelay: `${v}s` } as CSSProperties);

// ---------------------------------------------------------------------------
// Keyboard — the user typing
// ---------------------------------------------------------------------------
export function Keyboard({ active }: { active: boolean }) {
  const keys: { x: number; y: number; w: number; delay: number }[] = [];
  const rows = [
    { n: 9, y: 2, x0: 2 },
    { n: 8, y: 9.5, x0: 5.2 },
  ];
  rows.forEach((r, ri) => {
    for (let i = 0; i < r.n; i++) {
      keys.push({ x: r.x0 + i * 6.4, y: r.y, w: 5, delay: ((ri * 17 + i * 13) % 18) / 13 });
    }
  });
  return (
    <div className={`pf-kbd${active ? " pf-kbd--on" : ""}`}>
      <svg viewBox="0 0 62 24" width="72" height="28" aria-hidden="true">
        {keys.map((k) => (
          <rect key={`${k.x}-${k.y}`} className="pf-kbd__key" x={k.x} y={k.y} width={k.w} height={5.5} rx={1.2} style={d(k.delay)} />
        ))}
        <rect className="pf-kbd__key" x={3} y={17} width={9} height={5.5} rx={1.2} style={d(0.7)} />
        <rect className="pf-kbd__key pf-kbd__space" x={15} y={17} width={28} height={5.5} rx={1.2} style={d(0.2)} />
        <rect className="pf-kbd__key" x={47} y={17} width={9} height={5.5} rx={1.2} style={d(1.0)} />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Router — the external network routing
// ---------------------------------------------------------------------------
export function Router({ active }: { active: boolean }) {
  return (
    <div className={`pf-router${active ? " pf-router--on" : ""}`}>
      <svg viewBox="0 0 52 34" width="66" height="34" aria-hidden="true">
        {/* signal waves from the antennas */}
        <g className="pf-router__waves">
          <circle className="pf-router__wave" cx="26" cy="8" r="5" style={d(0)} />
          <circle className="pf-router__wave" cx="26" cy="8" r="5" style={d(0.5)} />
          <circle className="pf-router__wave" cx="26" cy="8" r="5" style={d(1.0)} />
        </g>
        {/* antennas */}
        <line className="pf-router__ant" x1="18" y1="18" x2="13" y2="7" />
        <line className="pf-router__ant" x1="34" y1="18" x2="39" y2="7" />
        <circle className="pf-router__tip" cx="13" cy="6" r="1.6" />
        <circle className="pf-router__tip" cx="39" cy="6" r="1.6" />
        {/* body */}
        <rect className="pf-router__body" x="8" y="18" width="36" height="12" rx="3" />
        {/* activity LEDs */}
        <circle className="pf-router__led" cx="14" cy="24" r="1.7" style={d(0)} />
        <circle className="pf-router__led" cx="20" cy="24" r="1.7" style={d(0.28)} />
        <circle className="pf-router__led" cx="26" cy="24" r="1.7" style={d(0.56)} />
        {/* port */}
        <rect className="pf-router__port" x="34" y="22.5" width="6" height="3" rx="0.8" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AluChip — the MCP server crunching
// ---------------------------------------------------------------------------
export function AluChip({ active }: { active: boolean }) {
  const cells: { x: number; y: number; delay: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      cells.push({ x: 13 + c * 6, y: 9 + r * 6, delay: ((r * 4 + c) * 37 % 11) / 16 });
    }
  }
  const pins = [9, 15, 21]; // pin rows on each side
  return (
    <div className={`pf-alu${active ? " pf-alu--on" : ""}`}>
      <svg viewBox="0 0 44 34" width="58" height="34" aria-hidden="true">
        {/* pins */}
        {pins.map((py) => (
          <g key={py} className="pf-alu__pins">
            <line className="pf-alu__pin" x1="6" y1={py + 1} x2="10" y2={py + 1} />
            <line className="pf-alu__pin" x1="34" y1={py + 1} x2="38" y2={py + 1} />
          </g>
        ))}
        {/* chip body */}
        <rect className="pf-alu__chip" x="10" y="6" width="24" height="22" rx="2.5" />
        {/* crunching cells */}
        {cells.map((cell) => (
          <rect key={`${cell.x}-${cell.y}`} className="pf-alu__cell" x={cell.x} y={cell.y} width={4} height={4} rx={0.8} style={d(cell.delay)} />
        ))}
      </svg>
    </div>
  );
}

// A fleet's sigil: a deterministic mini-spectrum barcode, one hairline per
// roster node, x from a stable hash of the node id, stroke = the role accent
// token. This is each fleet's identity in the sidebar rail — the brand mark
// (a rect stack, token-colored, no glow) applied to a fleet. The pure
// `fleetSigil` fold and the `FleetSigil` renderer live together (one file, so
// the fold and its view never drift and there is no case-only filename clash).

import type { FleetNode } from "./fleetModel";

export interface SigilBar {
  /** Position on the sigil's 0..1 axis (stable per node id). */
  x: number;
  /** The CSS var token for the stroke (role accent). */
  token: string;
  /** Dimmed when the node is disconnected. */
  faint: boolean;
}

/** FNV-1a over the id → a stable 0..1 position, so a fleet's barcode is fixed. */
function stablePosition(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

const ROLE_TOKEN: Record<string, string> = {
  root: "var(--agent-root)",
  main: "var(--agent-root)",
  worker: "var(--agent-worker)",
  reviewer: "var(--agent-explore)",
  explore: "var(--agent-explore)",
};

function roleToken(role: string): string {
  return ROLE_TOKEN[role] ?? "var(--agent-extra)";
}

/** The sigil bars for a roster, sorted along the axis for a clean barcode. */
export function fleetSigil(roster: FleetNode[]): SigilBar[] {
  return roster
    .map((node) => ({ x: stablePosition(node.id), token: roleToken(node.role), faint: !node.connected }))
    .sort((a, b) => a.x - b.x);
}

/** Renders a fleet's sigil inline like the sidebar brand-mark. */
export function FleetSigil({ roster }: { roster: FleetNode[] }) {
  const bars = fleetSigil(roster);
  const width = 42;
  const height = 16;
  return (
    <svg className="fleet-sigil" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={2 + bar.x * (width - 4)}
          y={2}
          width={1.4}
          height={height - 4}
          rx={0.7}
          fill={bar.token}
          opacity={bar.faint ? 0.3 : 0.95}
        />
      ))}
    </svg>
  );
}

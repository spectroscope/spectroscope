// A small feed-forward neural-network glyph for the LLM node — deliberately NOT a
// brain. Layers of fully-connected nodes; when the model is active the signals
// flow left→right and the nodes pulse. Pure SVG on design tokens (reskins across
// all genomes), transparent background, crisp at any zoom, honours reduced motion.

// Wide edition for the 440px LLM card: more layers, same idea.
const LAYERS = [3, 5, 6, 6, 5, 4, 2];
const W = 260;
const H = 60;
const PAD_X = 9;
const PAD_Y = 8;

interface NNNode { x: number; y: number; layer: number; out: boolean }

function layout(): NNNode[] {
  const nodes: NNNode[] = [];
  const cols = LAYERS.length;
  LAYERS.forEach((count, l) => {
    const x = PAD_X + (l * (W - 2 * PAD_X)) / (cols - 1);
    for (let i = 0; i < count; i++) {
      const y = count === 1 ? H / 2 : PAD_Y + (i * (H - 2 * PAD_Y)) / (count - 1);
      nodes.push({ x, y, layer: l, out: l === cols - 1 });
    }
  });
  return nodes;
}

export function NeuralNet({ active }: { active: boolean }) {
  const nodes = layout();
  const edges: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
  for (let l = 0; l < LAYERS.length - 1; l++) {
    const a = nodes.filter((n) => n.layer === l);
    const b = nodes.filter((n) => n.layer === l + 1);
    a.forEach((p, pi) => b.forEach((q, qi) => edges.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, key: `${l}-${pi}-${qi}` })));
  }
  return (
    <svg className={`pf-nn${active ? " pf-nn--active" : ""}`} viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" aria-hidden="true">
      <g className="pf-nn__edges">
        {edges.map((e, i) => (
          <line key={e.key} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} style={{ animationDelay: `${(i % 8) * 0.11}s` }} />
        ))}
      </g>
      <g className="pf-nn__nodes">
        {nodes.map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.out ? 3.4 : 2.8}
            className={n.out ? "pf-nn__out" : undefined}
            style={{ animationDelay: `${(i % 5) * 0.15}s` }}
          />
        ))}
      </g>
    </svg>
  );
}

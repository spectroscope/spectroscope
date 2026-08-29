// The drawing as a file: nodes, edges, rank labels and the lifecycle at the
// cursor, built PURELY from layout.ts data and artifact.ts folds — no DOM, no
// React Flow, which is what makes this a data-to-string function a plain-Node
// suite can hold.
//
// Self-contained by construction, the way export/html.ts documents are: the
// palette is written in as literals from the export themes (a file cannot
// inherit from an app it is no longer inside), the font stack names local
// families, and nothing in here fetches. The only URL is the SVG namespace
// NAME, which is an identifier, not a request.

import type { StateGraphLayout } from "./layout";
import { edgeStatsUpTo, lifecycleAt, type StateGraphRun } from "./artifact";
import { themeById } from "../export/themes";
import { escapeHtml } from "../export/markup";

export interface SvgInput {
  run: StateGraphRun;
  /** The layout for the orientation on screen — geometry decides orientation. */
  laid: StateGraphLayout;
  /** Record index the drawing stands at: the transport's cursor. */
  upto: number;
  /** Names the file in its <title>. */
  source: string;
  /** Export theme id; defaults to the brand default, like documentCss. */
  theme?: string;
}

/**
 * The state graph as one standalone SVG string.
 *
 * The class vocabulary mirrors the app's (lifecycle tint on the BORDER, walked
 * edges solid, the untaken path stepped back but never removed) under the
 * export's own x- prefix, with every colour resolved to a literal.
 */
export function stateGraphSvg({ run, laid, upto, source, theme }: SvgInput): string {
  const tk = themeById(theme ?? "spectroscope").tokens;
  const b = laid.bounds;
  const w = Math.max(1, Math.round(b.x1 - b.x0));
  const h = Math.max(1, Math.round(b.y1 - b.y0));
  const stats = edgeStatsUpTo(run.records, upto);

  const css = [
    `.x-bg{fill:${tk.bg}}`,
    `.x-n{fill:${tk.surface};stroke-width:1.25}`,
    `.x-n--pending{stroke:${tk["border-strong"]};fill:${tk.bg}}`,
    `.x-n--active{stroke:${tk.accent}}`,
    `.x-n--done{stroke:${tk.ok}}`,
    `.x-n--error{stroke:${tk.error}}`,
    `.x-name{font:11px ${tk["font-mono"]};fill:${tk.text}}`,
    `.x-r{font:10px ${tk["font-mono"]};fill:${tk["text-faint"]};letter-spacing:.14em}`,
    // The template's edge grammar, the same story the canvas tells: quiet,
    // dimmed once passed over, walked, live — dashes only ever mean "a branch
    // that MIGHT happen", so the dim state does not add its own.
    `.x-e{fill:none;stroke:${tk["border-strong"]};stroke-width:1.25;opacity:.6}`,
    `.x-e--cond{stroke-dasharray:5 4}`,
    `.x-e--untaken{opacity:.34}`,
    `.x-e--walked{stroke:${tk.ok};stroke-width:2;stroke-dasharray:none;opacity:.95}`,
    `.x-e--live{stroke:${tk.accent};stroke-width:2.4;stroke-dasharray:none;opacity:1}`,
    `.x-rule{stroke:${tk["border-strong"]};stroke-width:1;opacity:.35}`,
    `.x-el{font:11px ${tk["font-mono"]};fill:${tk["text-faint"]}}`,
    `.x-el--on{fill:${tk.ok}}`,
    `.x-el--now{fill:${tk.accent}}`,
  ].join("\n");

  const arrows = (
    [
      ["xar-quiet", tk["border-strong"]],
      ["xar-taken", tk.ok],
      ["xar-live", tk.accent],
    ] as const
  )
    .map(
      ([id, fill]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"` +
        ` markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth">` +
        `<path d="M0,1 L9,5 L0,9 z" fill="${fill}"/></marker>`,
    )
    .join("");

  const rules = laid.rankRules
    .map((r) => `<line class="x-rule" x1="${r.x1}" y1="${r.y1}" x2="${r.x2}" y2="${r.y2}"/>`)
    .join("\n");

  const edges = laid.edges
    .map((e) => {
      const key = `${e.from}->${e.to}`;
      const walked = stats.counts.has(key);
      const live = stats.last === key;
      const marker = live ? "xar-live" : walked ? "xar-taken" : "xar-quiet";
      const cls = [
        "x-e",
        e.kind === "conditional" ? "x-e--cond" : "",
        live ? "x-e--live" : walked ? "x-e--walked" : "x-e--untaken",
      ]
        .filter((c) => c !== "")
        .join(" ");
      const taken = stats.counts.get(key) ?? 0;
      const label = taken > 1 ? `×${taken}` : e.back ? "↺" : "";
      const text =
        label === ""
          ? ""
          : `<text class="x-el${live ? " x-el--now" : walked ? " x-el--on" : ""}"` +
            ` x="${e.labelX}" y="${e.labelY}" text-anchor="middle">${label}</text>`;
      return `<path class="${cls}" d="${escapeHtml(e.path)}" marker-end="url(#${marker})"/>${text}`;
    })
    .join("\n");

  const nodes = laid.nodes
    .map((n) => {
      const life = lifecycleAt(run.records, upto, n.id);
      return (
        `<g data-id="${escapeHtml(n.id)}">` +
        `<rect class="x-n x-n--${life}" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10"/>` +
        `<text class="x-name" x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle">` +
        `${escapeHtml(n.label)}</text></g>`
      );
    })
    .join("\n");

  const ranks = laid.rankLabels
    .map((l) => `<text class="x-r" x="${l.x}" y="${l.y}">rank ${l.rank}</text>`)
    .join("\n");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x0} ${b.y0} ${w} ${h}"` +
    ` width="${w}" height="${h}" role="img" aria-label="${escapeHtml(source)}">\n` +
    `<title>${escapeHtml(source)}</title>\n` +
    `<style>\n${css}\n</style>\n` +
    `<defs>${arrows}</defs>\n` +
    `<rect class="x-bg" x="${b.x0}" y="${b.y0}" width="${w}" height="${h}"/>\n` +
    `${rules}\n${edges}\n${nodes}\n${ranks}\n</svg>\n`
  );
}

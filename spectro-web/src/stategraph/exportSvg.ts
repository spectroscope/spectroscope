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
import { lifecycleAt, takenUpTo, type StateGraphRun } from "./artifact";
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
  const walked = takenUpTo(run, upto);

  const css = [
    `.x-bg{fill:${tk.bg}}`,
    `.x-n{fill:${tk.surface};stroke-width:1.25}`,
    `.x-n--pending{stroke:${tk["border-strong"]};fill:${tk.bg}}`,
    `.x-n--active{stroke:${tk.accent}}`,
    `.x-n--done{stroke:${tk.ok}}`,
    `.x-n--error{stroke:${tk.error}}`,
    `.x-name{font:11px ${tk["font-mono"]};fill:${tk.text}}`,
    `.x-r{font:10px ${tk["font-mono"]};fill:${tk["text-faint"]};letter-spacing:.14em}`,
    `.x-e{fill:none;stroke:${tk["border-strong"]};stroke-width:1.25;opacity:.4}`,
    `.x-e--cond{stroke-dasharray:5 4}`,
    `.x-e--untaken{opacity:.3;stroke-dasharray:4 4}`,
    `.x-e--walked{stroke:${tk.ok};stroke-width:2;stroke-dasharray:none;opacity:.95}`,
    `.x-e--back{stroke:${tk["sp-violet"]}}`,
  ].join("\n");

  const edges = laid.edges
    .map((e) => {
      const cls = [
        "x-e",
        e.kind === "conditional" ? "x-e--cond" : "",
        walked.has(`${e.from}->${e.to}`) ? "x-e--walked" : "x-e--untaken",
        e.back ? "x-e--back" : "",
      ]
        .filter((c) => c !== "")
        .join(" ");
      return `<path class="${cls}" d="${escapeHtml(e.path)}"/>`;
    })
    .join("\n");

  const nodes = laid.nodes
    .map((n) => {
      const life = lifecycleAt(run, upto, n.id);
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
    `<rect class="x-bg" x="${b.x0}" y="${b.y0}" width="${w}" height="${h}"/>\n` +
    `${edges}\n${nodes}\n${ranks}\n</svg>\n`
  );
}

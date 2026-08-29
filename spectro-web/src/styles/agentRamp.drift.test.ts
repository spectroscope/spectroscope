// Card 298. The handle ramp is produced in TypeScript (`agentTagColor` builds
// `var(--agent-w1)`…`var(--agent-w5)` from the tag), so phantomTokens.drift
// cannot see it: that guard reads stylesheets, and a token name assembled in a
// template literal is not in one. A missing --agent-w4 would therefore be
// silent — an invalid declaration, thrown away, the card painting whatever it
// inherits. This asks the question the other guard cannot.
//
// The second half is the theme trap the export file already documents: a skin
// that declares its own agent accents but NOT the ramp would inherit the
// espresso ramp onto its own ground. So the rule is all-or-nothing per block.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_RAMP_SLOTS, agentTagColor } from "../lab/agentDirectory";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

/** The custom properties one selector's block declares. */
function blockTokens(css: string, selector: string): Set<string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no such selector in the stylesheet: ${selector}`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  for (const line of body.split(";")) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*\S/i.exec(line);
    if (match) out.add(match[1]);
  }
  return out;
}

const tokensCss = read("tokens.css");
const designsCss = read("designs.css");

const BLOCKS: { id: string; tokens: Set<string> }[] = [
  { id: "espresso", tokens: blockTokens(tokensCss, ":root") },
  { id: "paper", tokens: blockTokens(tokensCss, '[data-design="paper"]') },
  { id: "still", tokens: blockTokens(designsCss, '[data-design="still"]') },
  { id: "graphite", tokens: blockTokens(designsCss, '[data-design="graphite"]') },
];

/** The token names agentTagColor can ever hand out for a worker tag. */
const rampTokens = Array.from({ length: AGENT_RAMP_SLOTS }, (_, i) =>
  agentTagColor(`w${i + 1}`).replace(/^var\(--|\)$/g, ""),
);

describe("the agent handle ramp exists wherever the accents do", () => {
  it("finds the blocks, so an empty result is not a broken walk", () => {
    expect(BLOCKS.map((b) => b.id)).toEqual(["espresso", "paper", "still", "graphite"]);
    expect(BLOCKS[0].tokens.has("agent-root")).toBe(true);
  });

  it("names one distinct token per slot", () => {
    expect(rampTokens).toEqual(["agent-w1", "agent-w2", "agent-w3", "agent-w4", "agent-w5"]);
  });

  for (const block of BLOCKS) {
    it(`${block.id}: declares the whole ramp, or none of it, exactly as it does the accents`, () => {
      const declaresAccents = block.tokens.has("agent-root");
      for (const token of rampTokens) {
        expect(block.tokens.has(token), `--${token} in ${block.id}`).toBe(declaresAccents);
      }
    });
  }
});

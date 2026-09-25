// Card 416, criterion 3: both commands render, the executed one first.
//
// The chat card's structured face and the export draw the same call. When rtk
// rewrote the line, the command region prints the line that ran after `$` and
// the model's line under a label of its own. When nothing was rewritten, one
// line renders, as before this card.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolViewBody } from "./ToolViewBody";
import { describeTool } from "./toolViews";
import { TOOL_CSS, toolViewHtml } from "../export/toolBody";
import { breakShellChain } from "./shellChain";
import { blockOf, read, rules } from "../testkit/source";
import { t, type Lang } from "../i18n/i18n";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const REWRITTEN = { command: "rtk ls -la", originalCommand: "ls -la", rewrittenBy: "rtk" };
const PLAIN = { command: "ls -la" };
const OUTPUT = "755  .spectro/\n644  notes.txt  4B\n";

function chatCard(input: unknown, lang: Lang = "en", name = "run_command"): string {
  setLang(lang);
  return renderToStaticMarkup(
    <ToolViewBody
      mode="structured"
      name={name}
      input={input}
      output={OUTPUT}
      isError={false}
      denied={false}
    />,
  );
}

/** The markup as a reader sees it: tags gone, entities decoded. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of every `tv-cmd` block, in document order, a `$` prompt read as
 *  "$ " (the app spaces it with a margin, not a character). */
function commandBlocks(markup: string): string[] {
  markup = markup.replace(/<span class="tv-prompt"[^>]*>\$<\/span>/g, "$ ");
  const out: string[] = [];
  const open = /<div class="tv-cmd[^"]*">/g;
  for (const m of markup.matchAll(open)) {
    // A command block holds spans only, never a nested div.
    const start = (m.index ?? 0) + m[0].length;
    out.push(
      text(markup.slice(start, markup.indexOf("</div>", start)))
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

describe("card 416: the chat card shows the command that ran and the one the model wrote", () => {
  for (const lang of ["en", "de"] as const) {
    it(`prints the executed line first and the model's line under its own label (${lang})`, () => {
      const markup = chatCard(REWRITTEN, lang);
      expect(commandBlocks(markup)).toEqual(["$ rtk ls -la", "ls -la"]);
      const read = text(markup);
      const label = t(lang, "tv.cmdAsWritten");
      const meta = t(lang, "tv.cmdRewritten", { by: "rtk" });
      expect(read).toContain(label);
      expect(read).toContain(meta);
      // The label heads the model's line, below the line that ran.
      expect(read.indexOf("rtk ls -la")).toBeLessThan(read.indexOf(label));
      expect(read.indexOf(label)).toBeLessThan(read.lastIndexOf("ls -la"));
    });
  }

  it("prints one line and no label when nothing was rewritten", () => {
    const markup = chatCard(PLAIN);
    expect(commandBlocks(markup)).toEqual(["$ ls -la"]);
    expect(text(markup)).not.toContain(t("en", "tv.cmdAsWritten"));
    expect(text(markup)).not.toContain(t("en", "tv.cmdRewritten", { by: "rtk" }));
  });

  it("keeps the model's line off a shell tool rtk never touches (owner call 2)", () => {
    const markup = chatCard(REWRITTEN, "en", "Bash");
    expect(commandBlocks(markup)).toEqual(["$ rtk ls -la"]);
    expect(text(markup)).not.toContain(t("en", "tv.cmdAsWritten"));
  });

  it("gives the model's line no prompt, since it never ran", () => {
    const markup = chatCard(REWRITTEN);
    expect(markup.match(/class="tv-prompt"/g)).toHaveLength(1);
  });
});

describe("card 416: the export draws the same two lines", () => {
  function exported(input: unknown, lang: Lang): string {
    return text(
      toolViewHtml(describeTool("run_command", input, OUTPUT, false), { name: "run_command", lang }),
    );
  }

  it("prints both, the executed line first, with the rewriter named", () => {
    for (const lang of ["en", "de"] as const) {
      const read = exported(REWRITTEN, lang);
      const executed = read.indexOf("$ rtk ls -la");
      expect(executed).toBeGreaterThanOrEqual(0);
      expect(read.indexOf("ls -la", executed + "$ rtk ls -la".length)).toBeGreaterThan(executed);
      expect(read).toContain(lang === "en" ? "rewritten by rtk" : "umgeschrieben von rtk");
      expect(read).toContain(lang === "en" ? "as the model wrote it" : "wie das Modell es schrieb");
    }
  });

  it("prints one line when nothing was rewritten", () => {
    const read = exported(PLAIN, "en");
    expect(read).toContain("$ ls -la");
    expect(read).not.toContain("as the model wrote it");
    expect(read).not.toContain("rewritten by");
  });
});

// Loop wave H3d, from the H3c browser stage: the model's line kept the shell
// colouring on its first word (`ls` in the highlight colour, `-la` dim), so it
// read as half of a command that ran. It never ran. It is drawn now as plain
// text in the secondary colour, and the executed line is the only coloured one.
describe("card 416: the model's line is plain text in the secondary colour", () => {
  /** A chained pair, so the joint break the chain breaker draws is checked too. */
  const CHAINED = {
    command: "cd sub && rtk ls -la",
    originalCommand: "cd sub && ls -la",
    rewrittenBy: "rtk",
  };

  /** The inner markup of every `tv-cmd` block, in document order. */
  function blockMarkup(markup: string): { classes: string; inner: string }[] {
    const out: { classes: string; inner: string }[] = [];
    for (const m of markup.matchAll(/<div class="(tv-cmd[^"]*)">/g)) {
      const start = (m.index ?? 0) + m[0].length;
      out.push({ classes: m[1], inner: markup.slice(start, markup.indexOf("</div>", start)) });
    }
    return out;
  }

  it("draws the model's line with no highlight span, the joint break kept", () => {
    const [executed, written] = blockMarkup(chatCard(CHAINED));
    expect(written.classes.split(" ")).toEqual(["tv-cmd", "tv-cmd--written", "mono"]);
    expect(written.inner).toBe(breakShellChain(CHAINED.originalCommand).replace(/&/g, "&amp;"));
    expect(written.inner).toContain("\n");
    // The line that ran keeps its colouring: it is the one highlighted line.
    expect(executed.inner).toMatch(/<span class="hl hl-/);
  });

  it("colours the model's line with the secondary text colour, by one rule of its own", () => {
    const own = rules("toolcard.css", read("../styles/toolcard.css", import.meta.url)).filter(
      (r) => r.selector === ".tv-cmd--written",
    );
    expect(own).toHaveLength(1);
    expect(own[0].body.trim()).toBe("color: var(--text-dim);");
  });

  it("does the same in the export: plain text, a class of its own, the dim colour", () => {
    const html = toolViewHtml(describeTool("run_command", CHAINED, OUTPUT, false), {
      name: "run_command",
      lang: "en",
    });
    const pres = [...html.matchAll(/<pre class="(x-tv-cmd[^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g)];
    expect(pres.map((m) => m[1])).toEqual(["x-tv-cmd", "x-tv-cmd x-tv-cmd--written"]);
    expect(pres[1][2]).toBe(breakShellChain(CHAINED.originalCommand).replace(/&/g, "&amp;"));
    expect(pres[0][2]).toMatch(/<span class="hl hl-/);
    expect(blockOf(TOOL_CSS, ".x-tv-cmd--written")).toBe("color:var(--text-dim)");
  });
});

// Card 269, AC 6: "the operator sees the same thing the model does". The verify
// pass of 2026-08-17 showed that criterion resting on a source grep alone —
// componentReach.drift.test.ts pins that the ARGUMENT is handed over, and the
// export test pins the saved file, but nothing rendered the chip. Two bites
// proved the hole: hard-coding the key to `tv.change.changed` printed
// "changed"/"geändert" over an unchanged write, and making the chip return null
// drew no chip at all — 290 test files and 4198 tests stayed green through
// both. The word is the whole feature, so the word is what this file asserts.
//
// It reads the rendered markup of BOTH faces, because the app draws this body
// from two places: the chat's tool card, and the trace's structured detail. The
// second one was absent until this pass (finding 3) — the section that feeds it
// never carried the field, so the trace showed a raw `fileChange: unchanged`
// ledger row while the chat card and the export showed the chip.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolViewBody } from "./ToolViewBody";
import { describeEvent, toolCallsById } from "./eventDetail";
import { DetailSectionView } from "./TraceView";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

afterEach(() => setLang("en"));

/**
 * The chip as the operator reads it: its outcome class and its word, paired.
 *
 * Paired on purpose. "changed" is a SUBSTRING of "unchanged", so a test that
 * looked for the word alone would pass on the exact confusion this card exists
 * to end — and one that looked for the class alone would pass while the chip
 * printed the opposite word. Null means no chip was drawn at all, which is its
 * own required outcome (a tool that touched no file makes no claim).
 */
function chip(markup: string): string | null {
  const found = /<span class="change-chip change-([a-z]+)">([^<]*)<\/span>/.exec(markup);
  return found === null ? null : `${found[1]}=${found[2]}`;
}

const WRITE_INPUT = { path: "src/particleEngine.js", content: "export const spawn = () => {};\n" };
const EDIT_INPUT = { path: "config.txt", old_string: "port=8080", new_string: "port=8080" };

/** The chat card's face: what ToolCard mounts, with the word off the record. */
function chatCard(name: string, input: unknown, output: string, fileChange?: string): string {
  return renderToStaticMarkup(
    <ToolViewBody
      mode="structured"
      name={name}
      input={input}
      output={output}
      isError={false}
      denied={false}
      {...(fileChange === undefined ? {} : { fileChange })}
    />,
  );
}

/** The trace's face: the payload as it lands on the wire, through the section. */
function traceBody(name: string, input: unknown, output: string, fileChange?: string): string {
  const calls = toolCallsById([{ type: "tool_call", callId: "c1", name, input }]);
  const sections = describeEvent(
    "tool_result",
    {
      agentId: "main",
      callId: "c1",
      output,
      isError: false,
      durationMs: 3,
      ts: 2,
      ...(fileChange === undefined ? {} : { fileChange }),
    },
    calls,
  );
  const tool = sections.find((s) => s.kind === "tool");
  if (tool?.kind !== "tool") throw new Error("the trace lost the tool section");
  return renderToStaticMarkup(<DetailSectionView section={tool} lang="en" />);
}

describe("the chip prints the outcome the record carries, in the operator's language", () => {
  // One row per outcome, both languages. The German is the half a reword is
  // most likely to break, and "unverändert" is the one an operator scans for.
  const expected: Record<Lang, Record<string, string>> = {
    en: { created: "created=created", changed: "changed=changed", unchanged: "unchanged=unchanged" },
    de: { created: "created=neu", changed: "changed=geändert", unchanged: "unchanged=unverändert" },
  };

  for (const lang of ["en", "de"] as Lang[]) {
    for (const outcome of ["created", "changed", "unchanged"]) {
      it(`says ${expected[lang][outcome].split("=")[1]} for a ${outcome} write in ${lang}`, () => {
        setLang(lang);
        const markup = chatCard("write_file", WRITE_INPUT, "Wrote: a.js (31 bytes)", outcome);
        expect(chip(markup)).toBe(expected[lang][outcome]);
      });
    }
  }

  it("says unverändert for the replacement that put the same string back", () => {
    setLang("de");
    const markup = chatCard("edit_file", EDIT_INPUT, "Edited: config.txt (1 replacement)", "unchanged");
    expect(chip(markup)).toBe("unchanged=unverändert");
  });

  // Absence is not "unchanged". A pre-269 session, an import, and every tool
  // that touched no file all arrive here with nothing, and a chip invented for
  // them would report a fact the run never established.
  it("draws no chip when the record made no claim", () => {
    expect(chip(chatCard("write_file", WRITE_INPUT, "Wrote: a.js (31 bytes)"))).toBeNull();
    expect(chip(chatCard("edit_file", EDIT_INPUT, "Edited: config.txt (1 replacement)"))).toBeNull();
  });

  // A word this build does not know is shown as no word rather than as itself:
  // the class would land in no stylesheet and the key in no dictionary, so the
  // chip would be an untranslated raw token in the middle of the card.
  it("draws no chip for a word this build does not know", () => {
    expect(chip(chatCard("write_file", WRITE_INPUT, "Wrote: a.js (31 bytes)", "shrunk"))).toBeNull();
  });
});

describe("the trace opens the same body, and now gets the same word (finding 3)", () => {
  it("carries the outcome from the payload through the section to the chip", () => {
    expect(chip(traceBody("write_file", WRITE_INPUT, "Wrote: a.js (31 bytes)", "unchanged"))).toBe(
      "unchanged=unchanged",
    );
    expect(chip(traceBody("edit_file", EDIT_INPUT, "Edited: config.txt (1 replacement)", "created"))).toBe(
      "created=created",
    );
  });

  it("draws no chip in the trace either when the payload said nothing", () => {
    expect(chip(traceBody("write_file", WRITE_INPUT, "Wrote: a.js (31 bytes)"))).toBeNull();
  });

  // The chip replaces the ledger row, it does not join it. The leftover ledger
  // exists so no field of a payload can go missing from the trace; once the
  // field has a shape of its own, leaving it in the ledger too would print the
  // same fact twice, once translated and once as a raw wire token.
  it("stops showing the raw field beside the chip that now says it", () => {
    const calls = toolCallsById([
      { type: "tool_call", callId: "c1", name: "write_file", input: WRITE_INPUT },
    ]);
    const sections = describeEvent(
      "tool_result",
      {
        callId: "c1",
        output: "Wrote: a.js (31 bytes)",
        isError: false,
        durationMs: 3,
        fileChange: "unchanged",
        ts: 2,
      },
      calls,
    );
    const rows = sections.find((s) => s.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("rows");
    expect(rows.rows.map((r) => r.key)).not.toContain("fileChange");
    // The witness that the ledger is still doing its job at all.
    expect(rows.rows.map((r) => r.key)).toContain("durationMs");
  });
});

// Card 363, the half of it that is not CSS: a box that grew while its text
// stayed cut is a worse lie than the small box was.
//
// `cut()` put `CLIP_CHARS = 4000` on a file body before it reached either face
// of the body chip, and the comment over that constant said the full payload
// lives in raw or json. Both halves of that sentence are false where it matters
// most:
//
//   the RAW face cuts with the same constant, so it reaches exactly as far;
//   the JSON face only reaches further when the output PARSES — for text it
//   falls back to a `pre` that was cut at 4,000 too, under a line promising the
//   output "shown verbatim" (`tv.notJson`).
//
// So for a plain file body past 4,000 characters, NO face of the card reached
// the end. Measured 2026-09-01 over 411 transcript files (every 19th of the
// 7,796 under ~/.claude/projects): of 2,016 `Read` results, 982 — 48.71% —
// are longer than 4,000 characters. Half the file bodies in the store were cut
// in every face at once.
//
// `FULL_CHARS = 48000` is the clip for a body with no face that reaches
// further. Over the same 2,016 reads, 45 (2.23%) are still longer than that and
// the longest tool result in the sample is 75,076 characters — so this is a
// bound, not a promise, and the "... (truncated)" line still has to appear when
// it bites. That residual is asserted here rather than left to be discovered.
//
// The raw face keeps 4,000, and that is asserted too. It is the narrow reading
// of a sentence that used to be broad: this card widened the reach of the two
// faces where nothing else reaches, and did NOT widen every clip in the file.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolViewBody } from "./ToolViewBody";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const HEAD = "ALPHAHEADMARKER";
const TAIL = "OMEGATAILMARKER";

/**
 * A file body of roughly `chars` characters, with a marker at each end.
 *
 * Deliberately free of markdown syntax that `bodyFace` refuses: no leading
 * whitespace (which sends a body back to the bytes with a note) and no
 * emphasis characters (which can be paired into the middle of a word). The
 * point of the fixture is the clip, not the face probe.
 */
function body(chars: number): string {
  const line = "The card shows what the tool returned, line after line.\n";
  let out = `${HEAD}\n\n`;
  while (out.length + line.length + TAIL.length + 2 < chars) out += line;
  return `${out}\n${TAIL}\n`;
}

/** One card, as the chat mounts it. */
function card(mode: "structured" | "json" | "raw", path: string, output: string): string {
  return renderToStaticMarkup(
    <ToolViewBody
      mode={mode}
      name="Read"
      input={{ file_path: path }}
      output={output}
      isError={false}
      denied={false}
    />,
  );
}

/** What a marker's presence says, as one readable line per case. */
function reach(markup: string): string {
  return [
    markup.includes(HEAD) ? "head" : "-",
    markup.includes(TAIL) ? "tail" : "-",
    markup.includes("(truncated)") ? "cut" : "-",
  ].join(" ");
}

const LONG = body(20000);

describe("a long file body reaches the end of the card it is drawn on", () => {
  it("carries a 20,000-character body whole into the rendered face", () => {
    const markup = card("structured", "notes.md", LONG);
    expect(markup, "the markdown preview is the face the owner named").toContain('class="tv-md"');
    expect(reach(markup)).toBe("head tail -");
  });

  it("carries the same body whole into the bytes face", () => {
    // The other side of ONE chip. The two faces are the same box under two
    // classes, so a reach that differed between them would be the discrepancy
    // this card exists to end, one level below the stylesheet.
    const markup = card("structured", "notes.txt", LONG);
    expect(markup).toContain('class="tv-well mono"');
    expect(reach(markup)).toBe("head tail -");
  });

  it("still says so when a body outruns even the lifted clip", () => {
    // 2.23% of the store's reads do. The box grew; the sentence about the box
    // has to stay true for them too.
    const markup = card("structured", "notes.md", body(60000));
    expect(reach(markup)).toBe("head - cut");
  });

  it("gives a text output the same reach on the json face, which calls it verbatim", () => {
    const markup = card("json", "notes.txt", LONG);
    expect(markup, "the json face admits a text output is not JSON").toContain("not JSON");
    expect(reach(markup)).toBe("head tail -");
  });

  it("leaves a JSON value uncapped on the json face, however long it is", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) wide[`key${i}`] = "a value long enough to matter";
    wide.last = TAIL;
    const payload = JSON.stringify(wide);
    expect(payload.length).toBeGreaterThan(48000);
    expect(reach(card("json", "notes.json", payload))).toBe("- tail -");
  });

  it("leaves the raw face where it was, at 4,000", () => {
    // Said out loud because the comment over CLIP_CHARS used to claim the
    // opposite. The raw face is a second reading of the SAME payload the
    // structured face now carries whole, so it is not the face that has to
    // reach the end — and this test is the sentence narrowed to the coverage.
    expect(reach(card("raw", "notes.txt", LONG))).toBe("head - cut");
  });
});

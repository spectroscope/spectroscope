// One place that turns source into coloured spans, so every surface that shows
// code colours it the same way: the markdown blocks in an answer, and the
// command and file bodies on a tool card.
//
// An unknown language renders as plain text on purpose. Colouring is a claim
// about what the characters MEAN, and a wrong claim about a shell command is
// worse than an uncoloured one.

import type { ReactNode } from "react";
import type { HlLang } from "../workspace/highlight";
import { tokenize } from "../workspace/highlight";

/**
 * Colour `text` as `lang`, or return it untouched when `lang` is null.
 *
 * @param text the source, returned byte for byte across the spans
 * @param lang the tokenizer language, or null to render plain
 * @return the spans, or the original string
 */
export function highlight(text: string, lang: HlLang | null): ReactNode {
  if (lang === null || text === "") return text;
  return tokenize(text, lang).map((tok, i) =>
    tok.cls === "plain" ? (
      tok.text
    ) : (
      <span key={i} className={`hl hl-${tok.cls}`}>
        {tok.text}
      </span>
    ),
  );
}

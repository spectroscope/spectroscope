// Card 249: the source reading — line numbers, the house highlighter, and
// indentation folding. Fold state is this mount's own: a closed tab drops it
// with the component, which is also how the content is released.

import { useMemo, useState } from "react";
import { hlLangForPath, tokenize } from "./highlight";
import type { Token } from "./highlight";
import { foldRegions, tokenLines, visibleLineNumbers } from "./sourceCode";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

function LineContent({ tokens, plain }: { tokens: Token[] | null; plain: string }) {
  if (tokens === null) return <>{plain}</>;
  return (
    <>
      {tokens.map((tok, idx) =>
        tok.cls === "plain" ? (
          tok.text
        ) : (
          <span key={idx} className={`hl hl-${tok.cls}`}>
            {tok.text}
          </span>
        ),
      )}
    </>
  );
}

export function SourceView({ path, text }: { path: string; text: string }) {
  const lang = useLang();
  const lines = useMemo(() => text.split("\n"), [text]);
  const hl = hlLangForPath(path);
  const highlighted = useMemo(() => (hl === null ? null : tokenLines(tokenize(text, hl))), [text, hl]);
  const regions = useMemo(() => foldRegions(lines), [lines]);
  const byStart = useMemo(() => new Map(regions.map((r) => [r.start, r])), [regions]);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());

  const toggle = (start: number): void => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });
  };

  const visible = visibleLineNumbers(lines.length, folded, regions);
  return (
    <div className="ws-src mono" role="group" aria-label={path}>
      {visible.map((n) => {
        const region = byStart.get(n);
        const isFolded = region !== undefined && folded.has(n);
        return (
          <div key={n} className="ws-src-row">
            <span className="ws-src-ln tabular" aria-hidden="true">
              {n + 1}
            </span>
            <span className="ws-src-caret">
              {region !== undefined && (
                <button
                  type="button"
                  className="ws-fold-caret"
                  aria-expanded={!isFolded}
                  aria-label={t(lang, "ws.foldRegion")}
                  onClick={() => toggle(n)}
                >
                  {isFolded ? "▸" : "▾"}
                </button>
              )}
            </span>
            <span className="ws-src-line">
              <LineContent tokens={highlighted?.[n] ?? null} plain={lines[n]} />
              {isFolded && (
                <button
                  type="button"
                  className="ws-fold-badge tabular"
                  title={t(lang, "ws.foldedLines", { n: region.end - region.start })}
                  onClick={() => toggle(n)}
                >
                  ⋯ {region.end - region.start}
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

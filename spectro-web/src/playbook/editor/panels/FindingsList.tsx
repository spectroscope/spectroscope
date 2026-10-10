// Card 483: the validator's findings. A finding whose path names a node or an
// arrow is a button that selects it; any other is plain text.

import { t } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";
import type { PlaybookDoc, Selection } from "../doc";
import { findingTarget } from "../options";

export function FindingsList({
  doc,
  findings,
  onPick,
}: {
  doc: PlaybookDoc;
  findings: { path: string; message: string }[];
  onPick: (selection: NonNullable<Selection>) => void;
}) {
  const lang = useLang();
  return (
    <section className="pbe-findings" aria-label={t(lang, "pb.findings")}>
      <h3 className="pbe-findings-title">{t(lang, "pb.findings")}</h3>
      {findings.length === 0 ? (
        <p className="pbe-note">{t(lang, "pbe.none")}</p>
      ) : (
        <ul>
          {findings.map((f, i) => {
            const target = findingTarget(f.path, doc);
            return (
              <li key={`${f.path}:${i}`}>
                {target === null ? (
                  <span className="pbe-mono">{f.path}</span>
                ) : (
                  <button type="button" className="pbe-link pbe-mono" onClick={() => onPick(target)}>
                    {f.path}
                  </button>
                )}{" "}
                {f.message}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

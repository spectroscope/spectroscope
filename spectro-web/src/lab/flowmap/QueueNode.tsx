// The backlog above the main agent (card 331), in its own module.
//
// WHY ITS OWN FILE. React Flow takes a node through the `nodeTypes` map and
// never through JSX, and `componentReach.drift.test.ts` cannot tell that from
// an orphan while the two share a file — it failed on exactly this component
// before the move. `nodes.tsx` already records the rule for card 306's box:
// "Imported, the import IS the attachment."

import type { NodeProps } from "@xyflow/react";
import { Handles } from "./handles";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";

/**
 * The backlog above the main agent (card 331).
 *
 * <p>Shows a DEPTH and the texts it can honestly show — never a matched list.
 * Measured over 342 Claude Code transcripts on 2026-09-01: of 15,477 queue
 * operations, 5,287 (34.2 %) carry no content at all, 6,751 of the 10,190 that
 * do share their text with another, one appears 59 times, and the frame carries
 * no id. So a dequeue retires depth and never a named row; the count of what
 * left is printed beside the names rather than subtracted from them.</p>
 *
 * @param props React Flow's node props; `data` is the folded queue view
 * @returns the card
 */
export function QueueNode({ data }: NodeProps) {
  const d = data as { depth: number; named: string[]; unnamed: number; retired: number };
  const lang = useLang();
  return (
    <div className={`pf-card pf-queue${d.depth > 0 ? " pf-card--active" : ""}`} data-queue-depth={d.depth}>
      <Handles />
      <div className="pf-queue__head">
        <span className="pf-queue__title">{t(lang, "lab.queue.title")}</span>
        <span className="pf-queue__depth" data-testid="queue-depth">
          {d.depth}
        </span>
      </div>
      {d.named.length > 0 && (
        <ul className="pf-queue__list">
          {d.named.slice(0, 3).map((text, i) => (
            <li key={`${text}-${i}`} className="pf-queue__row">
              {text}
            </li>
          ))}
        </ul>
      )}
      {/* Two separate facts, and both are stated. A node that showed two of
          three entries and said nothing about the third would teach the reader
          to trust a list that is missing a third of itself. */}
      {d.unnamed > 0 && (
        <p className="pf-queue__unnamed">{t(lang, "lab.queue.unnamed").replace("{n}", String(d.unnamed))}</p>
      )}
      {d.retired > 0 && (
        <p className="pf-queue__retired">{t(lang, "lab.queue.retired").replace("{n}", String(d.retired))}</p>
      )}
    </div>
  );
}

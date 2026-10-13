// Card 503, criterion 8: the sessions other processes of this machine host,
// under the rail's own. A row says the name other agents address it by, the
// face that hosts it (the app, a terminal, spectro run, a schedule, a fleet
// node), its folder and what it is doing. It opens nothing here: the session
// belongs to another process.
//
// Card 555: the density reaches these rows too, through the same `parts` the
// rail's own rows get. A peer row has no dot, so at minimal it is its name;
// the face and the folder and state line come back at normal and extended.

import type { LiveSessionRow } from "../state/liveSessions";
import { liveLineOf } from "../state/liveSessions";
import type { RowParts } from "../state/density";
import { t, type Lang } from "../i18n/i18n";

const FACES = new Set(["server", "repl", "headless", "cron", "node"]);

export function PeerRoster({
  lang,
  rows,
  parts,
}: {
  lang: Lang;
  rows: readonly LiveSessionRow[];
  /** What this density draws, from `rowParts()`: the list's own value. */
  parts: RowParts;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="peer-roster" aria-label={t(lang, "nav.peers")}>
      <div className="peer-roster-head">{t(lang, "nav.peers")}</div>
      {rows.map((row) => {
        const face =
          row.face !== undefined && FACES.has(row.face) ? t(lang, `nav.face.${row.face}`) : (row.face ?? "");
        const line = liveLineOf(row);
        return (
          <div key={`${row.pid ?? 0}:${row.id}`} className="peer-row" data-face={row.face ?? ""}>
            <span className="peer-row-name">{row.name ?? row.id}</span>
            {parts.liveLine && <span className="peer-row-face"> · {face}</span>}
            {parts.liveLine && line !== undefined && <span className="peer-row-line">{line}</span>}
          </div>
        );
      })}
    </section>
  );
}

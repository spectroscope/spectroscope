// Card 445: the stored sessions in two groups. Pinned sessions head the list
// under "Pinned"; the rest follow under "Recent". Since card 458 the sessions
// this page holds are rows of the same list, so there is no live row to place.
// While nothing is pinned the list has no headings at all.

import type { ReactNode } from "react";
import type { SessionMeta } from "../events";
import { t, type Lang } from "../i18n/i18n";
import type { SessionGroupsOf } from "../state/sessionMeta";

export function SessionGroups(props: {
  lang: Lang;
  groups: SessionGroupsOf;
  /** Draws one stored row. */
  row: (s: SessionMeta) => ReactNode;
}) {
  const { lang, groups } = props;
  const headed = groups.pinned.length > 0;
  return (
    <>
      {headed && <p className="sidebar-eyebrow session-group-eyebrow">{t(lang, "nav.pinned")}</p>}
      {groups.pinned.map(props.row)}
      {headed && <p className="sidebar-eyebrow session-group-eyebrow">{t(lang, "nav.recent")}</p>}
      {groups.rest.map(props.row)}
    </>
  );
}

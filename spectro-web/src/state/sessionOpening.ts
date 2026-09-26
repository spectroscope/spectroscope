// Card 431: the sign that a session is being opened.
//
// The owner, 2026-09-25: "aktuell weis man nicht das es lädt, es hängt
// einfach". Opening his big recorded session took 3.5 s from the click to the
// chat, and nothing on screen changed in between. App raises this sign at the
// click and lowers it in the same state update that shows the session, so the
// sign and the view never both show and never both miss.
//
// Pure module: the sign's shape, what a new navigation ticket does to it, and
// the row titles it is named by.

/** The loading sign of one open. */
export interface SessionOpening {
  /** The navigation ticket of the open that raised it. */
  ticket: number;
  /** The id that open was asked for. */
  sessionId: string;
  /** For a session open, the first prompt the session list carried for it,
   *  `""` for a row with no prompt, and null when no list row was in hand (a
   *  deep link before the list loaded). For an import, the import's label. */
  title: string | null;
  /** Card 435: "trace" when the sign stands over the first build of an
   *  archive's trace rather than over an open. Absent for an open. */
  purpose?: "trace";
}

/**
 * What a newly issued navigation ticket leaves of the sign.
 *
 * <p>Any navigation supersedes an open in flight: a live row, a fleet, a new
 * chat, an import, a scenario, another session. Each of them issues a ticket,
 * so the sign of an older open goes down right there, and not only when the
 * superseded open next checks its ticket.</p>
 */
export function openingAfterIssue(opening: SessionOpening | null, ticket: number): SessionOpening | null {
  return opening !== null && opening.ticket !== ticket ? null : opening;
}

// The session list lives in the sidebar, and an open arrives with an id. The
// sidebar hands every list it loads to this store, so an open started from a
// row, a resume or an address finds the row's words by id.
const titles = new Map<string, string>();

/** Replace the known titles with the ones of the list just loaded. A row with
 *  a title (card 445) is named by it, as the row itself is. */
export function rememberSessionTitles(
  list: ReadonlyArray<{ id: string; firstPrompt: string; title?: string }>,
): void {
  titles.clear();
  for (const row of list) {
    titles.set(row.id, (row.title ?? "").trim() !== "" ? row.title! : row.firstPrompt);
  }
}

/** What the last loaded list names a session by: its title when it has one,
 *  else its first prompt (`""` when that is empty). Null for an id that list
 *  did not hold. */
export function sessionTitleOf(id: string): string | null {
  return titles.get(id) ?? null;
}

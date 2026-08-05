// Is this file one agent's transcript, or a session?
//
// A Claude Code session file and a standalone subagent file are the same
// format, and the importer used to read both as sessions. That worked for one
// of them. In a session file a sidechain record whose spawn is missing really
// is unattributable, and skipping it is right — the file is silent about who
// ran it. In a subagent file EVERY record is sidechain and the spawn lives in
// another file entirely, so the same rule deleted the whole document.
//
// The question the importer never asked is one level up, and it is a question
// about the file rather than about a record: are all of these sidechain, with
// nothing in here that could own them? Then this is not a session with orphans
// in it. It is one agent's transcript, and it names that agent on every line.
//
// THE SHAPE DECIDES, NEVER THE NAME. These files are written as
// `subagents/agent-<id>.jsonl`, and a filename is a convention somebody else
// maintains: a copy on a desktop, a rename, or another client's layout would
// make a name rule silently wrong. Measured over ~/.claude/projects on
// 2026-08-04, 5,152 files: the shape rule fires on 4,687 and the name rule
// fires on 4,687, and they are the same 4,687 — zero files where one fires and
// the other does not, in either direction. The name corroborates and decides
// nothing.
//
// Nothing here touches events.ts. This is a reading of somebody else's file,
// the idiom import/sourceNotes.ts already uses.

/** What a standalone subagent transcript says about itself. */
export interface SubagentTranscript {
  /** The agent the file is the transcript of. Read off the records, never
   *  synthesised: it is on every record of all 4,687 files in the corpus, and
   *  it is the id the parent's spawn handed out, so the trace can name the
   *  same agent the parent session names. */
  agentId: string;
  /** The session this agent ran under, when the file agrees on one. The parent
   *  itself is NOT in the file, which is why the root run carries no parentId;
   *  this is the pointer to where it lives. */
  sessionId?: string;
  /** What kind of agent it was ("general-purpose", "workflow-subagent",
   *  "Explore"), when the file names exactly one. */
  attributionAgent?: string;
}

/** A record's field, when it is a non-empty string. */
const str = (r: Record<string, unknown>, key: string): string | null => {
  const v = r[key];
  return typeof v === "string" && v !== "" ? v : null;
};

/** The one value the records agree on, or null for none and for disagreement.
 *  Disagreement is not a tie to be broken: a bar that named one of two session
 *  ids would be reading a coin toss out loud. */
function agreed(recs: Record<string, unknown>[], key: string): string | null {
  let found: string | null = null;
  for (const r of recs) {
    const v = str(r, key);
    if (v === null) continue;
    if (found === null) found = v;
    else if (found !== v) return null;
  }
  return found;
}

/**
 * The transcript this file is, when it is one agent's rather than a session's.
 *
 * @param records the file's parsed records, in file order
 * @return what the file says about its agent, or null when this is a session
 *         file — including a session file that merely carries an orphan, which
 *         keeps today's per-record skip and gets nothing from here
 */
export function readSubagentTranscript(records: unknown[]): SubagentTranscript | null {
  const recs: Record<string, unknown>[] = [];
  for (const r of records) if (!!r && typeof r === "object") recs.push(r as Record<string, unknown>);
  if (recs.length === 0) return null;
  // One record outside the sidechain is a parent, or the possibility of one,
  // and then the file is a session and the existing machinery owns it.
  for (const r of recs) if (r.isSidechain !== true) return null;
  const agentId = agreed(recs, "agentId");
  if (agentId === null) return null;
  const sessionId = agreed(recs, "sessionId");
  const attributionAgent = agreed(recs, "attributionAgent");
  return {
    agentId,
    ...(sessionId !== null ? { sessionId } : {}),
    ...(attributionAgent !== null ? { attributionAgent } : {}),
  };
}

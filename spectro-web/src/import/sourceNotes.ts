// What a transcript line says that no frame carries.
//
// Stage 1 made every imported line reachable. Most of what it exposed belongs
// in the source pane and nowhere else: identifiers, plumbing, constants. A
// small set of fields is different. Each one is something a person goes
// looking for and cannot find anywhere in the app today. Those get read out of
// the line here and worn as a chip on the frame the line produced.
//
// THE RULE, for every field in this file: a line that does not carry it
// produces NOTHING. Not an empty chip, not a dash, not a blank column. The
// majority of real transcripts predate most of these fields (3100 of 4496 carry
// no effort at all), and a chip that renders empty on the common case is worse
// than no chip. Every reader below therefore returns nothing rather than a
// placeholder, and every one of them is pinned on its absent case first.
//
// Nothing here touches events.ts: these are readings of somebody else's file,
// not events on our wire.

/**
 * One thing a line says about the turn it produced.
 *
 * `value` always travels VERBATIM from the file. Every one of these fields is a
 * small open vocabulary that its writer extends without asking us, so a lookup
 * table would silently drop the next word it learns. The chip carries a
 * translated label and the file's own token beside it.
 */
export type SourceNote = {
  /** skill:     the skill that was driving this turn.
   *  mcp:       the MCP server and tool whose output is still driving it.
   *  effort:    how hard the model was told to think on this turn ("xhigh").
   *  origin:    who wrote a user turn when it was NOT a person.
   *  truncated: the answer stopped on a limit, not on its own ending.
   *  fallback:  the model was swapped under the run, from one to another. */
  kind: "skill" | "mcp" | "effort" | "origin" | "truncated" | "fallback";
  value: string;
};

/** Every note kind, for the dictionary's coverage test. */
export const SOURCE_NOTE_KINDS = ["skill", "mcp", "effort", "origin", "truncated", "fallback"] as const;

/** Cheap prefilter: a line that names none of these cannot produce a note, and
 *  a real transcript is mostly such lines. Parsing all of them would mean a
 *  second full parse of a file that can run to 80 MB. */
const CANDIDATE = [
  '"effort"',
  '"origin"',
  '"max_tokens"',
  '"stop_sequence"',
  '"fallback"',
  '"attributionSkill"',
  '"attributionMcpServer"',
];

/** The endings that mean the answer was CUT OFF rather than finished: a token
 *  ceiling and a configured stop sequence. "end_turn" and "tool_use" are the
 *  model finishing, and a null is a message that reported no ending at all. */
const TRUNCATING = new Set(["max_tokens", "stop_sequence"]);

/** A fallback block names the models as objects, not as strings. */
const modelOf = (v: unknown): string | null => {
  if (v === null || typeof v !== "object") return null;
  const m = (v as { model?: unknown }).model;
  return typeof m === "string" && m !== "" ? m : null;
};

/**
 * What one line of an imported transcript says beyond its frames.
 *
 * @param line one raw line of the file, exactly as it was read
 * @return the notes, in a fixed order; empty for a line that says none of this,
 *         including a line that does not parse
 */
export function readSourceNotes(line: string): SourceNote[] {
  if (!CANDIDATE.some((c) => line.includes(c))) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return []; // a line we cannot read is a line we know nothing about
  }
  if (rec === null || typeof rec !== "object") return [];
  const notes: SourceNote[] = [];
  // WHAT WAS DRIVING THE TURN, before how hard it thought: a stretch of turns
  // that suddenly writes tests is explained by the skill in charge, not by the
  // effort level. Measured 2026-08-04 over the 167 session transcripts in
  // ~/.claude/projects: 19,595 records in 106 files name a skill and 28,952 in
  // 113 name an MCP server, all of it dropped until now.
  const skill = (rec as { attributionSkill?: unknown }).attributionSkill;
  // Verbatim, plugin prefix included. attributionPlugin is deliberately NOT a
  // chip of its own: it is a substring of this value on all 13,069 session
  // records that carry it and appears on none that lack a skill, so a second
  // chip would say one fact twice. attributionAgent is not read either — 0 of
  // the 306,425 records carrying it sit in a session transcript, it lives only
  // in the sibling agent-*.jsonl, and such a file imports to a single
  // provider_info frame with no row to wear a chip.
  if (typeof skill === "string" && skill !== "") notes.push({ kind: "skill", value: skill });
  // The server and the tool are ONE fact, and the file writes them as two
  // fields that never appear apart (28,952 session records carry both, 0 carry
  // either alone). "computer" on its own names nothing a reader can look up, so
  // the tool rides behind its server or not at all.
  const server = (rec as { attributionMcpServer?: unknown }).attributionMcpServer;
  if (typeof server === "string" && server !== "") {
    const tool = (rec as { attributionMcpTool?: unknown }).attributionMcpTool;
    const named = typeof tool === "string" && tool !== "" ? `${server}:${tool}` : server;
    notes.push({ kind: "mcp", value: named });
  }
  const effort = (rec as { effort?: unknown }).effort;
  if (typeof effort === "string" && effort !== "") notes.push({ kind: "effort", value: effort });
  // "human" is deliberately silent. Half the corpus predates the field, so an
  // absent origin and a human one have to look the same on screen: a "human"
  // chip would claim, on every older file, something the file never said.
  const origin = (rec as { origin?: unknown }).origin;
  if (origin !== null && typeof origin === "object") {
    const who = (origin as { kind?: unknown }).kind;
    if (typeof who === "string" && who !== "" && who !== "human") notes.push({ kind: "origin", value: who });
  }
  const message = (rec as { message?: unknown }).message;
  if (message === null || typeof message !== "object") return notes;
  // The message's OWN field, never the words wherever they appear: a tool
  // result quoting "max_tokens" is not an ending.
  const stop = (message as { stop_reason?: unknown }).stop_reason;
  if (typeof stop === "string" && TRUNCATING.has(stop)) notes.push({ kind: "truncated", value: stop });
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content))
    for (const block of content as { type?: unknown; from?: unknown; to?: unknown }[]) {
      if (block === null || typeof block !== "object" || block.type !== "fallback") continue;
      const from = modelOf(block.from);
      const to = modelOf(block.to);
      // Half a swap is not a swap: with one side missing there is nothing to
      // say that the announced model does not already say.
      if (from !== null && to !== null) notes.push({ kind: "fallback", value: `${from} → ${to}` });
    }
  return notes;
}

/**
 * The notes of a whole imported file, by line.
 *
 * Sparse on purpose: only lines that carry something appear, so a row's lookup
 * misses in the common case and costs nothing. Built once per import, and each
 * entry is a stable array, because the trace rows are memoized and a fresh
 * array per render would re-render the whole list during a delta flood.
 *
 * @param lines the import's own lines, or null/undefined for a session that was
 *              produced here and has no separate source
 */
export function sourceNoteIndex(
  lines: readonly string[] | null | undefined,
): ReadonlyMap<number, readonly SourceNote[]> {
  const index = new Map<number, readonly SourceNote[]>();
  if (!lines) return index;
  for (let i = 0; i < lines.length; i++) {
    const notes = readSourceNotes(lines[i]);
    if (notes.length > 0) index.set(i, notes);
  }
  return index;
}

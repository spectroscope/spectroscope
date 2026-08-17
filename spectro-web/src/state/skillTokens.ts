// Card 247: /skill tokens inside a message — the client half of the shape
// rule whose server twin is SkillInvocations.java (twin vector tables in the
// two test files). The transcript colors a token only when the name is in the
// installed catalog, because the color's meaning is "this was expanded", and a
// color that outruns the expansion is a lie.

/** One run of a user text: either plain prose or a known /skill token. */
export interface SkillTokenSegment {
  text: string;
  /** The skill name the token carries, or null for prose. */
  skill: string | null;
}

/** A token candidate: the slash's index, the exclusive end, the bare name. */
export interface TokenSpan {
  name: string;
  start: number;
  end: number;
}

/** Start of text, or one character that is not a letter, digit or slash, then
 *  the slash and a name in the skill charset (packs use a colon). The twin of
 *  the Java TOKEN pattern — change both or neither. */
const TOKEN = /(?:^|[^\p{L}\p{N}/])\/([\p{L}\p{N}][\p{L}\p{N}_:-]*)/gu;

/** Every token candidate in reading order, by shape alone — resolution is the
 *  caller's business, exactly as on the server. */
export function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const slashAt = m.index + (m[0].startsWith("/") ? 0 : 1);
    spans.push({ name: m[1], start: slashAt, end: slashAt + 1 + m[1].length });
  }
  return spans;
}

/**
 * The text split around its KNOWN tokens, in order; concatenating the segments
 * reproduces the text exactly (the markSegments invariant). Unknown candidates
 * stay inside the surrounding prose segment.
 */
export function skillTokenSegments(text: string, known: ReadonlySet<string>): SkillTokenSegment[] {
  const segments: SkillTokenSegment[] = [];
  let at = 0;
  for (const span of tokenSpans(text)) {
    if (!known.has(span.name)) continue;
    if (span.start > at) segments.push({ text: text.slice(at, span.start), skill: null });
    segments.push({ text: text.slice(span.start, span.end), skill: span.name });
    at = span.end;
  }
  if (at < text.length || segments.length === 0) {
    segments.push({ text: text.slice(at), skill: null });
  }
  return segments;
}

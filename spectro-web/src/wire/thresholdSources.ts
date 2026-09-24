// The names a compaction threshold's source rides the wire under.
//
// Java writes `CompactionThreshold.Source.wireName()`, the enum constant
// lowercased, on `context_info` and on `window_override`. This list is that
// enum as the web knows it; windowOverride.drift.test.ts reads the Java enum
// and turns red when the two differ, so a source added in Java cannot reach a
// union here that does not name it (card 390).
//
// A reader must still treat a word it does not recognise like an absent one:
// a page from before a new source meets it on a newer server.

export const THRESHOLD_SOURCES = ["override", "window", "model", "fallback", "window_override"] as const;

/** One of the sources the Java enum declares, lowercased. */
export type ThresholdSource = (typeof THRESHOLD_SOURCES)[number];

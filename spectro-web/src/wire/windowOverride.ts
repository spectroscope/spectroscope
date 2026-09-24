// The window the operator sets for one session from the context ring (card 390):
// the range the server allows, the reading of what was typed, and the frame.
//
// The server decides (spectro-server WindowOverrideRequest). These two numbers
// are its FLOOR and CEILING, mirrored so the set button is off for a value the
// server would refuse; windowOverride.drift.test.ts reads them from the Java
// file.

/** The smallest window a person may set, in tokens. */
export const WINDOW_OVERRIDE_FLOOR = 8_000;

/** The largest window a person may set, in tokens. */
export const WINDOW_OVERRIDE_CEILING = 10_000_000;

/**
 * What the ring's input holds, as a window the server would take.
 *
 * Plain digits only, blanks around them ignored. A separator is refused rather
 * than guessed: "512.000" is 512 thousand to a German reader and 512 to
 * `Number()`.
 *
 * @param draft the input's text as typed
 * @return the window in tokens, or null when the server would refuse it
 */
export function parseWindowDraft(draft: string): number | null {
  const text = draft.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const tokens = Number(text);
  return tokens >= WINDOW_OVERRIDE_FLOOR && tokens <= WINDOW_OVERRIDE_CEILING ? tokens : null;
}

/**
 * The client frame for a set or a clear.
 *
 * @param tokens the window to set, or null to clear it (never 0: the server
 *        refuses 0, and 0 is how the core spells "none")
 * @return the frame the socket sends
 */
export function windowOverrideFrame(tokens: number | null): {
  type: "set_window_override";
  tokens: number | null;
} {
  return { type: "set_window_override", tokens };
}

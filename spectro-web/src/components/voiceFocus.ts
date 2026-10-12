// Where the focus goes while someone dictates (card 527 criterion 4).
//
// When the first words of a recording appear, the focus moves to the Send
// button, so Enter stops the recording and sends. The message box stays one
// Shift+Tab away. Someone who types into the box during the recording keeps
// the focus there: a keystroke in the box cancels the move for this recording.
//
// Pure, like voiceButton.ts: the decision is tested here, Chat.tsx only calls
// `focus()` when it says so.

/** Where the rule stands within one recording. */
export interface FocusRule {
  /** A recording is running. */
  readonly recording: boolean;
  /** The focus already moved during this recording. */
  readonly moved: boolean;
  /** A key was typed in the message box during this recording. */
  readonly typed: boolean;
}

/** No recording. */
export const FOCUS_START: FocusRule = { recording: false, moved: false, typed: false };

/** What happened. */
export type FocusEvent =
  /** A recording started. */
  | { kind: "start" }
  /** The heard text changed; empty while nothing is recognised. */
  | { kind: "heard"; text: string }
  /** A key went down in the message box. */
  | { kind: "typed" }
  /** The recording ended. */
  | { kind: "stop" };

/**
 * One event, folded into the rule.
 *
 * @param rule where the rule stood
 * @param event what happened
 * @return the new rule, and whether the focus moves to Send now
 */
export function focusStep(rule: FocusRule, event: FocusEvent): { rule: FocusRule; moveNow: boolean } {
  switch (event.kind) {
    case "start":
      return { rule: { recording: true, moved: false, typed: false }, moveNow: false };
    case "stop":
      return { rule: FOCUS_START, moveNow: false };
    case "typed":
      return { rule: rule.recording ? { ...rule, typed: true } : rule, moveNow: false };
    case "heard": {
      const moveNow = rule.recording && !rule.moved && !rule.typed && event.text.trim() !== "";
      return { rule: moveNow ? { ...rule, moved: true } : rule, moveNow };
    }
  }
}

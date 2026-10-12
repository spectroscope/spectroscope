// The focus wiring of card 527 criterion 4, as a hook Chat calls.
//
// voiceFocus.ts decides; this hook keeps the rule across renders, calls
// focus() on the Send button when the rule says so, and hands Chat the
// keydown that cancels the move for the recording. Kept apart from Chat so
// the call itself is testable (chatSendFocus.test.tsx).

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { FOCUS_START, focusStep, type FocusRule } from "./voiceFocus";

/** What Chat binds: the Send button's ref and the textarea's keydown. */
export interface SendFocus {
  /** The ref for the Send button. */
  ref: RefObject<HTMLButtonElement | null>;
  /** A key went down in the message box. Enter and Tab do not count. */
  keyDown: (key: string) => void;
}

/**
 * Moves the focus to Send when the first words of a recording are heard.
 *
 * @param recording whether a recording runs now
 * @param heard what has been heard in it so far
 * @return the ref and the keydown for Chat to bind
 */
export function useSendFocus(recording: boolean, heard: string): SendFocus {
  const ref = useRef<HTMLButtonElement>(null);
  const rule = useRef<FocusRule>(FOCUS_START);
  // What the last effect saw, so a run with the same values changes nothing.
  const seen = useRef({ recording: false, heard: "" });
  useEffect(() => {
    const before = seen.current;
    if (before.recording === recording && before.heard === heard) return;
    seen.current = { recording, heard };
    let now = rule.current;
    if (before.recording !== recording) {
      now = focusStep(now, { kind: recording ? "start" : "stop" }).rule;
    }
    const step = focusStep(now, { kind: "heard", text: heard });
    rule.current = step.rule;
    if (step.moveNow) ref.current?.focus();
  }, [recording, heard]);
  const keyDown = useCallback((key: string): void => {
    if (key === "Enter" || key === "Tab") return;
    rule.current = focusStep(rule.current, { kind: "typed" }).rule;
  }, []);
  return { ref, keyDown };
}

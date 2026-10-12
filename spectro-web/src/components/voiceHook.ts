// The composer's microphone, behind one seam (card 527).
//
// Chat calls `useComposerVoice`, which is `useVoiceInput` in the app. A test
// that renders Chat without a DOM has no microphone, no AudioContext and no
// socket, so it swaps in a fake voice through `__setVoiceHook` and drives the
// send gesture against it. Nothing in the shipped app calls the setter.

import { useVoiceInput, type VoiceInput, type VoiceRoute } from "./useVoiceInput";

type VoiceHook = (onTranscript: (text: string) => void, live: boolean, where: VoiceRoute) => VoiceInput;

let current: VoiceHook = useVoiceInput;

/**
 * The composer's voice input.
 *
 * @param onTranscript where a transcript goes when no send claimed it
 * @param live whether this press opens a live session
 * @param where the route and the local chunk step
 * @return the microphone's state and controls
 */
export function useComposerVoice(
  onTranscript: (text: string) => void,
  live: boolean,
  where: VoiceRoute,
): VoiceInput {
  return current(onTranscript, live, where);
}

/**
 * Test only: replace the voice hook, or restore the real one with null.
 *
 * @param hook the fake, or null
 */
export function __setVoiceHook(hook: VoiceHook | null): void {
  current = hook ?? useVoiceInput;
}

// Pure view-model for the composer's send/stop cluster (card 78 #2+#3). While
// a run streams the composer stays alive: Send becomes Queue (the message
// waits as a chip and auto-sends on run_end) and a Stop button appears next to
// it — OpenAI-style, bottom is the primary stop. After a stop click the button
// reads "stopping" and disarms until the server's run_end flips running off,
// so the click visibly took (the card-78 bug was a stop that LOOKED ignored).
// Same pure split as micButtonState: decisions here, DOM in Chat.tsx.

import { t, type Lang } from "../i18n/i18n";

export interface ComposerButtonsView {
  /** true while a run streams — the stop button renders then. */
  showStop: boolean;
  /** true once stop was clicked and the run has not ended yet. */
  stopDisabled: boolean;
  stopLabel: string;
  sendLabel: string;
  /** Only an empty draft disables sending — running does not. */
  sendDisabled: boolean;
}

/**
 * Decides how the send/stop cluster presents itself.
 *
 * @param opts running: a run is active on the live view; stopping: stop was
 *             already requested; draftEmpty: nothing (trimmed) in the textarea
 * @param lang the chrome language for the labels
 */
export function composerButtons(
  opts: { running: boolean; stopping: boolean; draftEmpty: boolean },
  lang: Lang = "en",
): ComposerButtonsView {
  return {
    showStop: opts.running,
    stopDisabled: opts.stopping,
    stopLabel: t(lang, opts.stopping ? "chat.stopping" : "chat.stop"),
    sendLabel: t(lang, opts.running ? "chat.queue" : "chat.send"),
    sendDisabled: opts.draftEmpty,
  };
}

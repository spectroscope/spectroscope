// Pure view-model for the composer's send/stop seat (card 78 #2+#3; regrouped
// composer 2026-08-09). The box has exactly ONE button slot, bottom right,
// Claude-style. Send holds it. While a run streams the composer stays alive:
// with nothing drafted, Stop takes the seat (bottom is the primary stop), and
// the moment the draft has text again the seat flips back to Send — which
// reads "Queue" during a run, because that message waits as a chip and
// auto-sends on run_end. After a stop click the button reads "stopping" and
// disarms until the server's run_end flips running off, so the click visibly
// took (the card-78 bug was a stop that LOOKED ignored). Same pure split as
// micButtonState: decisions here, DOM in Chat.tsx.

import { t, type Lang } from "../i18n/i18n";

export interface ComposerButtonsView {
  /** Who holds the in-box seat. Never both: a draft outranks the stop,
   *  because typing is the declared intent to send. */
  seat: "send" | "stop";
  /** true once stop was clicked and the run has not ended yet. */
  stopDisabled: boolean;
  stopLabel: string;
  sendLabel: string;
  /** Only an empty draft disables sending — running does not. */
  sendDisabled: boolean;
}

/**
 * Decides who sits in the send/stop seat and how it presents itself.
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
    seat: opts.running && opts.draftEmpty ? "stop" : "send",
    stopDisabled: opts.stopping,
    stopLabel: t(lang, opts.stopping ? "chat.stopping" : "chat.stop"),
    sendLabel: t(lang, opts.running ? "chat.queue" : "chat.send"),
    sendDisabled: opts.draftEmpty,
  };
}

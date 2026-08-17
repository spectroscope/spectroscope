// Card 244: the transcript's sign of life while the agent works and nothing
// else moves. The caret and the thinking dot both live on an OPEN assistant
// turn, so they cover neither the stretch from run_start to the first delta
// nor a running tool — exactly the seconds that read as "is it stuck?". The
// line yields to an open permission question, because that wait is the
// owner's, not the model's.

import { useEffect, useState } from "react";
import type { UiState } from "../state/reducer";
import { formatTimer } from "./voiceButton";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Whether the working line has a job: a live view, a running run, no open
 *  permission question, and no open assistant turn already pulsing its own
 *  indicator (the caret or the thinking dot). */
export function showWorkingLine(
  state: Pick<UiState, "running" | "turns" | "pendingPermissions">,
  liveView: boolean,
): boolean {
  if (!liveView || !state.running) return false;
  if (state.pendingPermissions.length > 0) return false;
  const last = state.turns[state.turns.length - 1];
  return last === undefined || last.kind !== "assistant";
}

/** Elapsed since the run started, in the recording indicator's voice ("0:07").
 *  Null without a start stamp; clock skew clamps to zero inside formatTimer. */
export function workingTimer(now: number, startTs: number | null): string | null {
  if (startTs === null) return null;
  return formatTimer(now - startTs);
}

export function WorkingLine(props: { startTs: number | null }) {
  const lang = useLang();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (props.startTs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [props.startTs]);
  const timer = workingTimer(now, props.startTs);
  return (
    <div className="working-line" role="status" aria-live="polite">
      <span className="thinking-dot" aria-hidden="true" />
      <span>{t(lang, "chat.working")}</span>
      {timer !== null && <span className="tabular">{timer}</span>}
    </div>
  );
}

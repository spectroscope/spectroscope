// Talking to a node that stays (card 166's server leg) — the box that was a
// labelled mock until the hub learned the message verb.
//
// One component for both faces (the bus card and the agent feed) so the two can
// never disagree about who can be talked to or what an answer meant. The rule
// itself is in nodeMessaging.ts, shared with nothing else that could drift.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { canTakeMessages, sendOutcome, type Addressable } from "./nodeMessaging";

export interface NodeComposerProps {
  nodeId: string;
  /** The node's roster card — connectivity and its trigger note. */
  card: Addressable;
  /** The wrapper class, so each face keeps its own layout. */
  className: string;
}

export function NodeComposer({ nodeId, card, className }: NodeComposerProps) {
  const lang = useLang();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<{ ok: boolean; key: string } | null>(null);
  const [sending, setSending] = useState(false);

  const canSend = canTakeMessages(card);
  // Why the box is dead, in the operator's words rather than a shrug. The
  // offline case and the no-trigger case are different problems with different
  // fixes, so they are never collapsed into one tooltip.
  const disabledWhy = !card.connected ? t(lang, "bus.composerOffline") : t(lang, "bus.composerNoTrigger");

  const send = (): void => {
    const text = draft.trim();
    if (text === "" || !canSend || sending) return;
    setSending(true);
    setNote(null);
    void fetch(`/api/fleet/${encodeURIComponent(nodeId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
      // A fetch that never landed is status 0, which sendOutcome reads as a
      // failure — so the draft survives it. The one thing this must never do is
      // clear the box on an answer it did not understand.
      .then((res) => res.status)
      .catch(() => 0)
      .then((status) => {
        const outcome = sendOutcome(status);
        setNote(outcome);
        if (outcome.ok) setDraft("");
        setSending(false);
      });
  };

  return (
    <div className={className}>
      <input
        type="text"
        className="mono"
        placeholder={t(lang, "bus.composerPlaceholder")}
        value={draft}
        disabled={!canSend || sending}
        title={canSend ? undefined : disabledWhy}
        onChange={(e) => {
          setDraft(e.target.value);
          if (note !== null) setNote(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        type="button"
        disabled={!canSend || sending || draft.trim() === ""}
        title={canSend ? t(lang, "bus.composerSend") : disabledWhy}
        onClick={send}
      >
        →
      </button>
      {note !== null && (
        <span className={note.ok ? "composer-note" : "composer-note is-bad"} role="status">
          {t(lang, note.key)}
        </span>
      )}
    </div>
  );
}

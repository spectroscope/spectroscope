// Card 473, round three: an answer in the chat opens the LLM exchange that
// produced it. Closed until asked; on the gesture it reads the session's
// exchange index (an import's held wire, or the server's sidecar), picks the
// answer's exchange (wire/answerExchange.ts) and shows its bodies in the same
// pane the trace uses.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { findAnswerExchange } from "../wire/answerExchange";
import type { LlmExchangeMeta } from "../wire/llmWire";
import { LlmExchangeDetail } from "./LlmExchangeDetail";

export function AnswerExchange({
  sessionId,
  agentId,
  endTs,
  defaultOpen = false,
}: {
  /** The session the exchange fetch asks under (state/wireSession.ts). */
  sessionId: string;
  agentId: string;
  /** When the answer's usage line closed it. */
  endTs: number;
  defaultOpen?: boolean;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(defaultOpen);
  const [found, setFound] = useState<
    { kind: "loading" } | { kind: "none" } | { kind: "found"; meta: LlmExchangeMeta }
  >({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFound({ kind: "loading" });
    void findAnswerExchange(sessionId, { agentId, endTs }).then((meta) => {
      if (alive) setFound(meta === null ? { kind: "none" } : { kind: "found", meta });
    });
    return () => {
      alive = false;
    };
  }, [open, sessionId, agentId, endTs]);

  return (
    <div className="answer-exchange">
      <button
        type="button"
        className="link answer-exchange-toggle"
        aria-expanded={open}
        title={t(lang, "chat.exchangeTitle")}
        onClick={() => setOpen((o) => !o)}
      >
        {t(lang, open ? "chat.exchangeHide" : "chat.exchangeShow")}
      </button>
      {open && (
        <div className="answer-exchange-body">
          {found.kind === "loading" ? (
            <p className="trace-source-note">{t(lang, "chat.exchangeLoading")}</p>
          ) : found.kind === "none" ? (
            <p className="trace-source-note">{t(lang, "chat.exchangeNone")}</p>
          ) : (
            <LlmExchangeDetail payload={found.meta} sessionId={sessionId} face="structured" />
          )}
        </div>
      )}
    </div>
  );
}

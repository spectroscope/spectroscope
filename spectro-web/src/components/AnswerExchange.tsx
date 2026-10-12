// Card 473, round three: an answer in the chat opens the LLM exchange that
// produced it. Closed until asked; on the gesture it reads the session's
// exchange index (an import's held wire, or the server's sidecar), picks the
// answer's exchange (wire/answerExchange.ts) and shows its bodies in the same
// pane the trace uses.
//
// Card 519: the open pane carries the trace's face strip, so the owner can
// switch from the structured parts to the insight tree or the wire bytes. The
// faces come from the pane's own list, withdrawn per origin as the trace
// withdraws them. The choice lives in the open pane and nowhere else: it is not
// stored, it does not move the trace's master face, and a reopened exchange
// starts on Structured again.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { TraceOrigin } from "../state/traceFace";
import { findAnswerExchange } from "../wire/answerExchange";
import type { LlmExchangeMeta } from "../wire/llmWire";
import { LlmExchangeDetail, exchangeFacesOf, type ExchangeFace } from "./LlmExchangeDetail";

/**
 * One opened exchange with its face strip. Mounted only while the exchange is
 * open, so closing it drops the chosen face.
 */
export function ExchangeFacePane({
  meta,
  sessionId,
  origin,
}: {
  meta: LlmExchangeMeta;
  sessionId: string;
  /** Where the session came from; it decides which faces are on offer. */
  origin: TraceOrigin;
}) {
  const lang = useLang();
  const [face, setFace] = useState<ExchangeFace>("structured");
  const faces = exchangeFacesOf(origin);
  // Structured is on every list, so a withdrawn face lands there.
  const shown: ExchangeFace = faces.includes(face) ? face : "structured";
  return (
    <>
      <div className="trace-detail-modes" role="group" aria-label={t(lang, "trace.modeAria")}>
        {faces.map((f) => (
          <button key={f} type="button" aria-pressed={shown === f} onClick={() => setFace(f)}>
            {t(lang, `trace.mode.${f}`)}
          </button>
        ))}
      </div>
      <LlmExchangeDetail payload={meta} sessionId={sessionId} face={shown} />
    </>
  );
}

export function AnswerExchange({
  sessionId,
  agentId,
  endTs,
  origin = "native",
  defaultOpen = false,
}: {
  /** The session the exchange fetch asks under (state/wireSession.ts). */
  sessionId: string;
  agentId: string;
  /** When the answer's usage line closed it. */
  endTs: number;
  /** Where the session came from (state/traceFace.ts traceOriginOf). */
  origin?: TraceOrigin;
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
            <ExchangeFacePane meta={found.meta} sessionId={sessionId} origin={origin} />
          )}
        </div>
      )}
    </div>
  );
}

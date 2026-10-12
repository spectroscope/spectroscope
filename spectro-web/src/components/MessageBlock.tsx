// Card 503, criterion 7: one agent message in the chat.
//
// Every block names the other side (From or To), the time and the status. A
// message held for this operator, because it came from a session with other
// permissions, offers Deliver and Decline while the session is live; a stored
// session's held message offers nothing, the decision was taken or expired
// then. Every received message offers Reply, which pins the sender as the
// recipient of the composer's next send; that send leaves as
// send_peer_message, as the operator, never as a prompt.
//
// A message between the parent and a child sits in the child's thread; the
// main thread shows it once more as one line (compact). A workflow
// summariser's message to its parent is the run's answer (card 506): it sits
// in the main thread, in full, with no Reply.

import type { ClientMessage } from "../events";
import type { Turn } from "../state/reducer";
import { t, type Lang } from "../i18n/i18n";
import { clockTime } from "../format";

export type MessageTurn = Extract<Turn, { kind: "message" }>;

/** Who a Reply goes to: the sender's name, and its session when it is another session. */
export interface ReplyTarget {
  name: string;
  toSession?: string;
}

/**
 * @param msgId   the held message
 * @param deliver true for Deliver, false for Decline
 * @returns the frame the page sends
 */
export function decisionFrame(msgId: string, deliver: boolean): ClientMessage {
  return { type: "peer_message_decision", msgId, deliver };
}

/**
 * @param target who the reply goes to
 * @param text   the composer's draft
 * @returns the frame the page sends, or null for an empty draft
 */
export function replyFrame(target: ReplyTarget, text: string): ClientMessage | null {
  const body = text.trim();
  if (body === "") return null;
  return {
    type: "send_peer_message",
    to: target.name,
    ...(target.toSession !== undefined ? { toSession: target.toSession } : {}),
    text: body,
  };
}

/**
 * @param turn a received message
 * @returns who a Reply to it goes to
 */
export function replyTargetOf(turn: MessageTurn): ReplyTarget {
  return { name: turn.from, ...(turn.fromSession !== undefined ? { toSession: turn.fromSession } : {}) };
}

export function MessageBlock({
  turn,
  lang,
  live,
  onDecide,
  onReply,
  compact = false,
}: {
  turn: MessageTurn;
  lang: Lang;
  /** Whether this is a live session; a stored one decides nothing. */
  live: boolean;
  onDecide: (msgId: string, deliver: boolean) => void;
  onReply: (turn: MessageTurn) => void;
  /** The main thread's one line for a message between the parent and a child. */
  compact?: boolean;
}) {
  // A sent message that is held waits for the OTHER operator.
  const statusWord =
    turn.direction === "sent" && turn.status === "held"
      ? t(lang, "msg.status.heldThere")
      : t(lang, `msg.status.${turn.status}`);
  if (compact) {
    return (
      <div className="info-line neutral msg-line" data-msg-id={turn.msgId}>
        {t(lang, "msg.mainLine", { from: turn.from, to: turn.to, summary: turn.summary })}
        <span className="msg-line-status"> · {statusWord}</span>
      </div>
    );
  }
  const received = turn.direction === "received";
  const held = received && turn.status === "held" && live && turn.replay !== true;
  // Card 506: the run's answer comes from a summariser that has ended.
  const replyable = received && live && turn.answer !== true;
  const who = received ? t(lang, "msg.from", { name: turn.from }) : t(lang, "msg.to", { name: turn.to });
  return (
    <div
      className={`msg-block msg-block--${turn.direction} msg-status--${turn.status}${turn.answer === true ? " msg-block--answer" : ""}`}
      data-msg-id={turn.msgId}
      role="group"
      aria-label={who}
    >
      <div className="msg-head">
        <span className="msg-who">{who}</span>
        <span className="msg-time tabular">{clockTime(turn.time)}</span>
        <span className="msg-status">{statusWord}</span>
      </div>
      <div className="msg-text">{turn.text}</div>
      {held && <p className="msg-note">{t(lang, "msg.heldNote")}</p>}
      {(held || replyable) && (
        <div className="msg-actions">
          {held && (
            <>
              <button
                type="button"
                className="link"
                data-action="deliver"
                onClick={() => onDecide(turn.msgId, true)}
              >
                {t(lang, "msg.deliver")}
              </button>
              <button
                type="button"
                className="link"
                data-action="decline"
                onClick={() => onDecide(turn.msgId, false)}
              >
                {t(lang, "msg.decline")}
              </button>
            </>
          )}
          {replyable && (
            <button type="button" className="link" data-action="reply" onClick={() => onReply(turn)}>
              {t(lang, "msg.reply")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Card 301A: the handovers panel.
//
// Thin on purpose, the way ContextPeak is thin. Every decision this could get
// wrong — which way a handover went, whether the spawn tree or the role word
// decided that, which task a reply answers, what a lane's counters are — lives
// in messageLane.ts, which is pure and bitten branch by branch. What is left
// here is words and pixels.
//
// THE NUMBER YOU CAN CLICK. The governing rule the work fold states: the panel
// renders no number it cannot take you to. Every row carries its own RunEvent
// and hands it to App's existing focusInTrace seam, so a handover on screen is
// one click from the line that recorded it.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { agentTagColor } from "./agentDirectory";
import { messageLanes, type LaneMessage, type MessageLane } from "./messageLane";

/** The arrow a direction draws. A handover that the tree could not place is
 *  drawn sideways rather than being guessed into a hierarchy. */
const ARROW: Record<LaneMessage["direction"], string> = { down: "↓", up: "↑", side: "→" };

function Message(props: {
  msg: LaneMessage;
  lang: ReturnType<typeof useLang>;
  onOpen?: (msg: LaneMessage) => void;
}) {
  const { msg, lang, onOpen } = props;
  const meta = [
    t(lang, "lab.msg.chars", { n: msg.chars }),
    msg.answers === null ? null : t(lang, "lab.msg.answers", { n: msg.answers }),
  ].filter((s): s is string => s !== null);

  return (
    <li className="lab-msg-row">
      <button
        type="button"
        className="lab-msg-open"
        title={t(lang, "lab.msg.open")}
        aria-label={t(lang, "lab.msg.open")}
        onClick={onOpen === undefined ? undefined : () => onOpen(msg)}
      >
        <span className="lab-msg-line">
          <span className="lab-msg-tag mono" style={{ color: agentTagColor(msg.fromTag) }}>
            {msg.fromTag}
          </span>
          {/* A guessed direction is marked, never silently drawn as a fact. */}
          <span
            className={`lab-msg-arrow${msg.fromTree ? "" : " lab-msg-arrow--guessed"}`}
            title={msg.fromTree ? undefined : t(lang, "lab.msg.guessed")}
          >
            {ARROW[msg.direction]}
            {msg.fromTree ? "" : "?"}
          </span>
          <span className="lab-msg-tag mono" style={{ color: agentTagColor(msg.toTag) }}>
            {msg.toTag}
          </span>
          <span className="lab-msg-role">{msg.role}</span>
        </span>
        <span className="lab-msg-text">{msg.text}</span>
        <span className="lab-msg-meta tabular">{meta.join(" · ")}</span>
      </button>
    </li>
  );
}

function Lane(props: {
  lane: MessageLane;
  lang: ReturnType<typeof useLang>;
  onOpen?: (msg: LaneMessage) => void;
}) {
  const { lane, lang, onOpen } = props;
  return (
    <li className="lab-msg-lane">
      <div className="lab-msg-lane-head">
        <span className="lab-msg-tag mono" style={{ color: agentTagColor(lane.tag) }}>
          {lane.tag}
        </span>
        <span className="lab-msg-lane-name" title={lane.intent === "" ? undefined : lane.intent}>
          {lane.name}
        </span>
        <span className={`lab-msg-state lab-msg-state--${lane.state}`}>{lane.state}</span>
      </div>
      <p className="lab-msg-lane-counts tabular">
        {t(lang, "lab.msg.laneCounts", {
          in: formatTokens(lane.inTokens),
          out: formatTokens(lane.outTokens),
          tools: lane.toolCalls,
        })}
        {lane.gatesDenied > 0 ? ` · ${t(lang, "lab.msg.laneDenied", { n: lane.gatesDenied })}` : ""}
      </p>
      <ul className="lab-msg-list">
        {lane.messages.map((m) => (
          <Message key={m.index} msg={m} lang={lang} onOpen={onOpen} />
        ))}
      </ul>
    </li>
  );
}

export function HandoverLane(props: {
  applied: RunEvent[];
  /** App's focusInTrace seam. Absent = the rows render but do not navigate. */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const { applied, onFocusEvent } = props;
  const { lanes } = useMemo(() => messageLanes(applied), [applied]);

  // An agent_message carries no agentId, and the trace's agent filter lets a
  // row with none through (TraceView: `e.agentId !== undefined` guards it), so
  // the focused row can never be hidden by the scope this sets.
  const open =
    onFocusEvent === undefined ? undefined : (msg: LaneMessage): void => onFocusEvent(msg.from, msg.event);

  return (
    <div className="lab-msg">
      <p className="lab-msg-hint">{t(lang, "lab.msg.hint")}</p>
      {lanes.length === 0 ? (
        <p className="lab-msg-empty">{t(lang, "lab.msg.empty")}</p>
      ) : (
        <ul className="lab-msg-lanes">
          {lanes.map((lane) => (
            <Lane key={lane.agentId} lane={lane} lang={lang} onOpen={open} />
          ))}
        </ul>
      )}
    </div>
  );
}

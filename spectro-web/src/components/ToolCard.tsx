// One card per callId — the workhorse of the chat. tool_call creates it,
// tool_result switches the status; collapsed by default on level "normal",
// open by default on "extended" (card 78 #4) — a manual click on THIS card
// overrides the level until it unmounts. The whole header row is the toggle
// button. Status is always dot + text, never color alone.

import { useEffect, useState } from "react";
import { openImage } from "../state/imageViewer";
import type { CSSProperties } from "react";
import type { ToolCard as ToolCardModel } from "../state/reducer";
import { agentAccent, formatDuration } from "../format";
import { defaultOpen, useDisclosure } from "../state/disclosure";
import { TOOL_VIEW_MODES, setToolView, useToolView } from "../state/toolView";
import { ToolViewBody } from "./ToolViewBody";
import { toolTeaser } from "./toolTeaser";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { beacon } from "../state/levelingBeacon";

/** Live duration count-up tick while a tool runs. */
const RUNNING_TICK_MS = 250;
/** How long the copy button shows its "copied" confirmation. */
const COPY_FEEDBACK_MS = 1400;

export function ToolCard(props: { card: ToolCardModel; live: boolean; inThread?: boolean }) {
  const { card, live } = props;
  const lang = useLang();
  const level = useDisclosure();
  const viewMode = useToolView();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen(level, "tool");
  const [copied, setCopied] = useState(false);

  const denied = card.permission === "denied";
  const runningNow = live && card.status === "pending" && !denied;
  // Inside a chat thread the container already names the owner — no per-card badge.
  const subagent = card.agentId !== "main" && props.inThread !== true;

  // Live duration count-up while the tool executes (250 ms tick is enough).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!runningNow) return;
    const timer = window.setInterval(() => setNow(Date.now()), RUNNING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [runningNow]);

  const statusLabel = denied
    ? t(lang, "tool.denied")
    : card.status === "pending"
      ? runningNow
        ? t(lang, "tool.running")
        : t(lang, "tool.noResult")
      : card.status;

  const dotTone = denied
    ? "warn"
    : card.status === "pending"
      ? runningNow
        ? "accent pulse"
        : "faint"
      : card.status;

  const duration =
    card.durationMs !== undefined
      ? formatDuration(card.durationMs)
      : runningNow
        ? formatDuration(now - card.startedAt)
        : null;

  // The 2 px line on the left: error/denied status wins, otherwise the
  // subagent's pastel identifies the owner (decoration, never text color).
  const lineColor =
    card.status === "error"
      ? "var(--error)"
      : denied
        ? "var(--warn)"
        : subagent
          ? agentAccent(card.agentId)
          : "var(--border)";

  const copyOutput = (): void => {
    if (card.output === undefined) return;
    void navigator.clipboard.writeText(card.output).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  };

  return (
    <div className="tool-card" style={{ "--line-color": lineColor } as CSSProperties}>
      <button
        type="button"
        className="tool-card-head"
        aria-expanded={open}
        onClick={() => {
          setManual(!open);
          // Expanding is the act the ladder watches; collapsing again is not.
          if (!open) beacon("disclosure");
        }}
      >
        <span className={`dot ${dotTone}`} aria-hidden="true" />
        <span className="tool-name">{card.name}</span>
        {subagent && (
          <span
            className="agent-badge"
            style={{ "--agent-color": agentAccent(card.agentId) } as CSSProperties}
          >
            {card.agentId}
          </span>
        )}
        {/* One line, and the row's only clue while the card is folded: the
            fields that identify the call, with any body named by its size. */}
        <span className="tool-preview">
          {toolTeaser(card.name, card.input, (n) => t(lang, "tv.lines", { n }))}
        </span>
        {/* The gate outcome, made visible: an allowed call is didactically
            different from a permission-free one — it went through the gate. */}
        {card.permission !== undefined && (
          <span className={`gate-chip gate-${card.permission}`}>{t(lang, `gate.${card.permission}`)}</span>
        )}
        <span className={`tool-status status-${denied ? "denied" : card.status}`}>{statusLabel}</span>
        {duration !== null && <span className="badge tabular">{duration}</span>}
        {/* Card 265: the human wait, kept APART from the badge beside it. The tool
            worked for 0.0 s and the machine stood still for three minutes, and
            both numbers are true — which is the whole point of card 111's split
            and, until now, a number the session file carried and no surface
            showed (gateWaitMs has had no reader since it shipped). */}
        {card.askWaitMs !== undefined && (
          <span className="badge tabular tool-waited">
            {t(lang, "ask.waited", { d: formatDuration(card.askWaitMs) })}
          </span>
        )}
        <svg
          className={`chevron${open ? " open" : ""}`}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      <div className={`tool-card-body${open ? " open" : ""}`}>
        <div className="tool-card-inner">
          {/* Card 94: three faces of the same call — structured (the tool AS
              ITSELF), json (collapsible trees), raw (the untouched pair). The
              choice is a persisted preference, like the trace lenses. */}
          <div className="tv-modes" role="group" aria-label={t(lang, "tv.modeAria")}>
            {TOOL_VIEW_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`tv-mode${viewMode === m ? " tv-mode--on" : ""}`}
                aria-pressed={viewMode === m}
                onClick={() => setToolView(m)}
              >
                {t(lang, `tv.mode.${m}`)}
              </button>
            ))}
            {card.output !== undefined && !denied && (
              <button type="button" className="copy tv-copy" onClick={copyOutput}>
                {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
              </button>
            )}
          </div>
          {/* card.detail is what the tool RETURNED, when this card came out of
              an imported transcript (card 167). It is state the reducer patched
              on and nothing else; a card from a live run simply has none, and
              the body renders then exactly as it always did. */}
          <ToolViewBody
            mode={viewMode}
            name={card.name}
            input={card.input}
            output={card.output}
            isError={card.status === "error"}
            denied={denied}
            detail={card.detail}
            fileChange={card.fileChange}
          />
          {/* What the tool RETURNED as a picture, out of the transcript itself
              (card 179). Roughly 7,300 of the corpus's 8,788 image blocks sit in
              a tool_result rather than in a person's message — a screenshot from
              the browser, a rendered chart — and every one of them used to read
              as "[image/png · 31.0 KB]".

              Deliberately not the gallery: `state.images` means generated HERE,
              and this was read or grabbed. An <img src> and nothing else, so the
              data: URI the transcript supplied can never reach a navigation. */}
          {card.images !== undefined && card.images.length > 0 && (
            <div className="tool-card-shots">
              {card.images.map((a, i) => (
                <img
                  key={i}
                  className="tool-card-shot is-openable"
                  src={`data:${a.mediaType};base64,${a.dataBase64}`}
                  alt={a.name}
                  title={a.name}
                  loading="lazy"
                  onClick={() => openImage(a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

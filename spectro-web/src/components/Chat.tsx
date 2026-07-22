// The chat history plus composer. Assistant text is document flow (no bubble),
// user turns are compact cards, tools render as ToolCard. While a run streams,
// exactly one Coral caret pulses at the end of the text. The bonus-stage
// input channels live in their own hooks: useAttachments (drag-and-
// drop / file picker -> canvas downscale -> preview chips -> thumbnails on the
// sent turn) and useVoiceInput (MediaRecorder -> POST /api/transcribe
// -> the transcript lands IN THE INPUT, never straight at the agent).

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ClientMessage } from "../events";
import type { Turn, UiState } from "../state/reducer";
import { groupTurns } from "../state/threads";
import { agentAccent } from "../format";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { AttachmentPreview } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { useAttachments } from "./useAttachments";
import { useVoiceInput } from "./useVoiceInput";
import { formatTimer, micButtonState } from "./voiceButton";
import { ComposerGear } from "./ComposerGear";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

// Composer + scroll tuning, named so every line reads aloud.
const SCROLL_PIN_THRESHOLD_PX = 120; // this close to the bottom counts as "pinned"
const TEXTAREA_MAX_HEIGHT_PX = 150;
/** An armed delete button disarms again after this long. */
const DELETE_ARM_TIMEOUT_MS = 4000;

export function Chat(props: {
  state: UiState;
  /** true when this is the live socket view, false for a replayed archive. */
  liveView: boolean;
  onSend: (text: string, attachments?: PendingAttachment[]) => void;
  onReturnToLive: () => void;
  /** Present only for resumable archives (real stored sessions): picks the
   *  session back up as the live one, history re-uploaded on the next prompt. */
  onResume?: () => void;
  /** Present only for deletable archives: removes the stored session for
   *  good (JSONL + blobs). The button arms on the first click and only the
   *  second click within a few seconds actually deletes. */
  onDelete?: () => void;
  /** The one place client frames leave the app (App.tsx) — the composer
   *  gear uses it directly to send set_permission_mode. */
  sendClient: (msg: ClientMessage) => boolean;
}) {
  const { state, liveView } = props;
  const lang = useLang();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prevTurnCount = useRef(0);
  // attachment intake (drag-and-drop, file picker, pending chips).
  // The drop zone is the chat ROOT — the hook only hands out the handlers.
  const attachments = useAttachments(liveView);
  // microphone wiring — the transcript lands IN THE INPUT (never
  // straight at the agent), appended to whatever is already drafted.
  const voice = useVoiceInput((text) => setDraft((prev) => (prev ? `${prev} ${text}` : text)));

  // Keep the view pinned to the bottom while streaming — but only if the
  // reader has not scrolled up to study something.
  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_PIN_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    const newTurn = state.turns.length !== prevTurnCount.current;
    prevTurnCount.current = state.turns.length;
    if (el === null || !pinnedRef.current) return;
    // Smooth for new turns, instant while a turn streams (no scroll jitter).
    el.scrollTo({ top: el.scrollHeight, behavior: newTurn ? "smooth" : "auto" });
  });

  const autosize = (): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  };

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || state.running || !liveView) return;
    props.onSend(text, attachments.pending.length > 0 ? attachments.pending : undefined);
    setDraft("");
    attachments.clear();
    const el = textareaRef.current;
    if (el !== null) el.style.height = "auto";
  };

  const lastUserText = (): string | null => {
    for (let i = state.turns.length - 1; i >= 0; i--) {
      const turn = state.turns[i];
      if (turn !== undefined && turn.kind === "user") return turn.text;
    }
    return null;
  };

  const lastIndex = state.turns.length - 1;
  const mic = micButtonState(voice.micPhase, voice.micAvailable, state.running, lang);

  // Subagent turns nest into thread blocks (one per child burst, stream order);
  // main turns render flat. Pure grouping over the reducer's chronological
  // list — the trace tab keeps the flat truth.
  const blocks = useMemo(
    () => groupTurns(state.turns, state.cards, state.agents),
    [state.turns, state.cards, state.agents],
  );

  const renderTurn = (turn: Turn, i: number, inThread = false) => {
    switch (turn.kind) {
      case "user":
        return (
          <div key={i} className="user-turn">
            <div className="eyebrow">{t(lang, "chat.you")}</div>
            {turn.attachments !== undefined && turn.attachments.length > 0 && (
              <div className="user-attachments">
                {turn.attachments.map((a, j) => (
                  <img
                    key={j}
                    className="user-attachment-thumb"
                    src={`data:${a.mediaType};base64,${a.dataBase64}`}
                    alt={a.name}
                    title={a.name}
                  />
                ))}
              </div>
            )}
            <div className="user-text">{turn.text}</div>
          </div>
        );
      case "assistant":
        return (
          <div key={i} className="assistant-turn">
            {turn.agentId !== "main" && !inThread && (
              <span
                className="agent-badge"
                style={{ "--agent-color": agentAccent(turn.agentId) } as CSSProperties}
              >
                {turn.agentId}
              </span>
            )}
            {turn.thinking !== "" && (
              <ThinkingDisclosure
                text={turn.thinking}
                active={liveView && state.thinkingActive && i === lastIndex}
              />
            )}
            {/* The answer gets its own card, markdown-rendered; a turn that is
                still all thinking shows no empty box. */}
            {(turn.text !== "" || (liveView && state.running && i === lastIndex)) && (
              <div className="assistant-answer">
                <Markdown text={turn.text} />
                {liveView && state.running && i === lastIndex && (
                  <span className="caret pulse" aria-hidden="true" />
                )}
              </div>
            )}
          </div>
        );
      case "tool": {
        const card = state.cards[turn.callId];
        return card !== undefined ? (
          <ToolCard key={turn.callId} card={card} live={liveView} inThread={inThread} />
        ) : null;
      }
      case "info":
        return (
          <div key={i} className={`info-line ${turn.tone}`}>
            {turn.infoKey !== undefined ? t(lang, turn.infoKey, turn.infoVars) : turn.text}
          </div>
        );
      case "error":
        return (
          <div key={i} className="error-card">
            <div className="eyebrow">{t(lang, "chat.error")}</div>
            <div className="error-text">{turn.text}</div>
            {liveView && !state.running && lastUserText() !== null && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  const text = lastUserText();
                  if (text !== null) props.onSend(text);
                }}
              >
                {t(lang, "chat.sendAgain")}
              </button>
            )}
          </div>
        );
    }
  };

  return (
    <main className="chat" {...attachments.dropHandlers}>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="off"
        aria-label={t(lang, "chat.historyAria")}
      >
        {state.turns.length === 0 ? (
          <div className="empty">
            {/* The M1 line bundle in front of the title, wordmark type — the same
                treatment as the sidebar brand (owner 2026-07-20). */}
            <h1 className="empty-brand">
              <svg className="empty-logo" viewBox="0 0 64 64" width="36" height="36" aria-hidden="true">
                <rect x="13.2" y="14" width="2.6" height="36" rx="0.7" fill="var(--sp-red)" />
                <rect x="21.7" y="14" width="1.6" height="36" rx="0.7" fill="var(--sp-amber)" />
                <rect x="28.9" y="14" width="5.2" height="36" rx="0.7" fill="var(--sp-teal)" />
                <rect x="42" y="14" width="2" height="36" rx="0.7" fill="var(--sp-ocean)" />
                <rect x="49.35" y="14" width="1.3" height="36" rx="0.7" fill="var(--text-faint)" />
              </svg>
              {t(lang, "chat.emptyTitle")}
            </h1>
            <p>{t(lang, "chat.emptyTag")}</p>
            {/* The little sign (owner 2026-07-20): the gear up top holds the
                design switch (spectro white included) and the particle dials. */}
            <p className="empty-hint">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              {t(lang, "chat.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="history">
            {blocks.map((b) =>
              b.kind === "turn" ? (
                renderTurn(b.turn, b.index)
              ) : (
                <section
                  key={`thread-${b.agentId}-${b.items[0].index}`}
                  className="chat-thread"
                  style={{ "--agent-color": agentAccent(b.agentId) } as CSSProperties}
                >
                  <div className="chat-thread-head">
                    <span
                      className="agent-badge"
                      style={{ "--agent-color": agentAccent(b.agentId) } as CSSProperties}
                    >
                      {b.agentId}
                    </span>
                    {b.label !== null && <span className="thread-label">{b.label}</span>}
                    {b.task !== "" && (
                      <span className="thread-task" title={b.task}>
                        {b.task}
                      </span>
                    )}
                  </div>
                  <div className="chat-thread-body">
                    {b.items.map((it) => renderTurn(it.turn, it.index, true))}
                  </div>
                </section>
              ),
            )}
          </div>
        )}
      </div>

      {liveView ? (
        <div className="composer">
          <div className="composer-column">
            <AttachmentPreview
              attachments={attachments.pending}
              onRemove={attachments.removeAt}
            />
            {mic.recording && (
              <div className="recording-indicator" aria-live="polite">
                <span className="dot accent pulse" aria-hidden="true" />
                <span>{t(lang, "chat.recording", { t: formatTimer(voice.recordMs) })}</span>
              </div>
            )}
            <div className={attachments.dragOver ? "composer-inner drag-over" : "composer-inner"}>
              <input
                ref={attachments.fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="sr-only"
                aria-hidden="true"
                tabIndex={-1}
                onChange={attachments.onFilePicked}
              />
              <button
                type="button"
                className="icon-button attach-button"
                aria-label={t(lang, "chat.attachAria")}
                title={t(lang, "chat.attach")}
                onClick={attachments.openFilePicker}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="12" height="10" rx="1.5" />
                  <circle cx="5.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3.5-3.5L9 11l2.5-2.5L14 11" />
                </svg>
              </button>
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                placeholder={t(lang, "chat.placeholder")}
                aria-label={t(lang, "chat.placeholder")}
                onChange={(e) => {
                  setDraft(e.target.value);
                  autosize();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <button
                type="button"
                className={mic.recording ? "icon-button attach-button mic-button recording" : "icon-button attach-button mic-button"}
                aria-label={mic.title}
                aria-pressed={mic.recording}
                title={mic.title}
                disabled={mic.disabled}
                onClick={() => void voice.toggleMic()}
              >
                {mic.recording ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <rect x="3" y="3" width="10" height="10" rx="1.5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="6" y="1.5" width="4" height="8" rx="2" />
                    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
                    <path d="M8 12v2.5M5.5 14.5h5" />
                  </svg>
                )}
              </button>
              <ComposerGear
                workspaceInfo={state.workspace}
                permissionMode={state.permissionMode}
                sendClient={props.sendClient}
              />
              <button
                type="button"
                className="primary send"
                disabled={draft.trim() === "" || state.running}
                onClick={submit}
              >
                {state.running ? t(lang, "chat.running") : t(lang, "chat.send")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="composer archive-bar">
          <div className="composer-inner">
            <span className="archive-note">{t(lang, "lab.viewingArchive")}</span>
            {props.onResume !== undefined && (
              <button
                type="button"
                className="primary resume-btn"
                title={t(lang, "arch.resumeTitle")}
                onClick={props.onResume}
              >
                {t(lang, "arch.resume")}
              </button>
            )}
            {props.onDelete !== undefined && <DeleteButton onDelete={props.onDelete} />}
            <button type="button" className="link" onClick={props.onReturnToLive}>
              {t(lang, "lab.returnLive")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/** Deleting is irreversible, so the button is a two-step affordance: the
 *  first click ARMS it (label flips to the confirm question, error-tinted),
 *  the second click within 4 s deletes; doing nothing disarms it again. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  const lang = useLang();
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DELETE_ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`ghost archive-delete${armed ? " archive-delete--armed" : ""}`}
      title={t(lang, "arch.deleteTitle")}
      onClick={() => {
        if (armed) onDelete();
        else setArmed(true);
      }}
    >
      {armed ? t(lang, "arch.deleteConfirm") : t(lang, "arch.delete")}
    </button>
  );
}


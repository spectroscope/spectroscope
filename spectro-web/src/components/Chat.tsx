// The chat history plus composer. Assistant text is document flow (no bubble),
// user turns are compact cards, tools render as ToolCard. While a run streams,
// exactly one Coral caret pulses at the end of the text. The bonus-stage
// input channels live in their own hooks: useAttachments (drag-and-
// drop / file picker -> canvas downscale -> preview chips -> thumbnails on the
// sent turn) and useVoiceInput (MediaRecorder -> POST /api/transcribe
// -> the transcript lands IN THE INPUT, never straight at the agent).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ClientMessage, RunEvent } from "../events";
import type { Turn, UiState } from "../state/reducer";
import { groupTurns, groupTurnsV2 } from "../state/threads";
import { agentAccent, cacheSplit, clockTime, formatDuration } from "../format";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { AttachmentPreview } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { useAttachments } from "./useAttachments";
import { useVoiceInput } from "./useVoiceInput";
import { liveReading, type LiveRoute } from "./liveTranscription";
import { composerHeight, showsPlaceholder } from "./composerGrowth";
import { useLiveWanted } from "../state/liveWanted";
import { voiceErrorKey } from "./voiceError";
import { opensTheSheet, type SttStatus } from "./voiceNoticeReading";
import { markVoiceNoticeSeen, readVoiceNoticeSeen, shouldShowVoiceNotice } from "./voiceNoticeFlag";
import { VoiceNotice } from "./VoiceNotice";
import { meterBars } from "./micLevel";
import { MicMenu } from "./MicMenu";
import { formatTimer, micButtonState } from "./voiceButton";
import { composerButtons } from "./composerButtons";
import { useSlashPicker } from "./SlashPicker";
import type { QueuedMessage } from "../state/sendQueue";
import { ComposerGear } from "./ComposerGear";
import { DisclosureMenu } from "./DisclosureMenu";
import { TranslatePanel } from "./TranslatePanel";
import { ExportMenu } from "./ExportMenu";
import { openImage } from "../state/imageViewer";
import { SessionFolderButtons } from "./SessionFolderButtons";
import { chatTools } from "./chatTools";
import { useTranslation } from "../state/translate";
import { useChatWidth } from "../state/chatWidth";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { reportCount, useSearch } from "../state/search";
import { chatHits, markSegments } from "./chatSearch";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

// Composer + scroll tuning, named so every line reads aloud.
const SCROLL_PIN_THRESHOLD_PX = 120; // this close to the bottom counts as "pinned"
/** Where the draft stops growing: ten full lines. The textarea's line-height
 *  is pinned to 22px in modal-composer.css (an integer on purpose — the
 *  inherited 1.55 × 14px = 21.7px would round per line and land the cap
 *  mid-line) and it carries 10px padding top and bottom but NO border of its
 *  own (the surrounding .composer-box wears the chrome). So scrollHeight at
 *  ten lines is exactly 10 × 22 + 2 × 10 = 240, the cap sits ON a line
 *  boundary, and the scrollbar only appears once an eleventh line exists.
 *  Keep in sync with the .composer-box textarea max-height. */
const TEXTAREA_MAX_HEIGHT_PX = 240;
/** An armed delete button disarms again after this long. */
const DELETE_ARM_TIMEOUT_MS = 4000;

export function Chat(props: {
  state: UiState;
  /** Identity of the VIEW ("live" or the replay id) — prefixes the turn/card
   *  React keys so a live card's local state (manual disclosure, scroll pin)
   *  can never be reconciled onto a DIFFERENT session's same-index turn when
   *  the app swaps views without remounting (review find F5). */
  viewKey?: string;
  /** The RECORDED flat stream of this view, never a translated copy: the
   *  translate sheet plans and re-runs from it, and translating a translation
   *  is how a record turns into a rumour. What is RENDERED comes from `state`,
   *  which App folds from the translated stream while the toggle shows it. */
  events?: readonly RunEvent[];
  /** Names an export file. The live session id or the replay id — exportId is
   *  not it, since that is only set for resumable archives. */
  sessionLabel?: string | null;
  /** The imported transcript's store-relative path, when this session came from
   *  the store. A paste or a picked file has no address, and therefore no
   *  folders to offer. */
  storePath?: string | null;
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
  /** Opens the native folder picker (App's pickWorkspace) for the "set folder"
   *  choice in the new-chat workspace chooser; live sessions only. */
  onPickFolder?: () => void;
  /** Messages waiting for the current run to end (card 78 #3) — App owns the
   *  queue and its drain; the composer renders the chips. */
  queued?: QueuedMessage[];
  onUnqueue?: (id: number) => void;
  /** The bottom stop button (card 78 #2) — same wire as the header stop. */
  onAbort?: () => void;
  /** True from the stop click until run_end: the button reads "stopping …". */
  stopRequested?: boolean;
  /** The stored session id when this archive can be exported (card 95). */
  exportId?: string;
  /** The stored session id when its llm-wire sidecar answered non-empty: the
   *  recorded exchanges as an NDJSON download beside the session's own. Absent
   *  whenever the index named nothing — a link to an empty file is a claim. */
  llmWireId?: string;
  /** Which grouping the scroll uses (branch chat-v2). Default "v1" — every
   *  existing caller keeps the recorded rendering, subagent turns and all.
   *  "v2" lifts the child turns out and asks {@link renderChip} for the marker
   *  that stands where they were. ChatV2 is the only caller that passes it, so
   *  a v2 bug cannot reach the view the owner uses every day. */
  grouping?: "v1" | "v2";
  /** v2 only: the chip that replaces a child's turns. Given the work ids that
   *  start here; ChatV2 owns what it looks like, because it owns the panel it
   *  points at. */
  renderChip?: (workIds: string[], index: number) => ReactNode;
}) {
  const { state, liveView } = props;
  const lang = useLang();
  const chatWidth = useChatWidth(); // the reading width, from the disclosure menu
  // How many passages are translated for this view. Read here so the tools row
  // and the translate panel answer "is there anything to show?" from one place.
  const translated = useTranslation(props.viewKey ?? "live");
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The live layer, measured by autosize. A ref rather than state: it is read
  // during a layout pass, not rendered from.
  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A live view follows the edge; an archive does not. An import is a record
  // you read from the beginning, so it must not open at its own end.
  const pinnedRef = useRef(props.liveView);
  const prevTurnCount = useRef(0);
  // attachment intake (drag-and-drop, file picker, pending chips).
  // The drop zone is the chat ROOT — the hook only hands out the handlers.
  const attachments = useAttachments(liveView);
  // microphone wiring — the transcript lands IN THE INPUT (never
  // straight at the agent), appended to whatever is already drafted.
  // Card 187 step 7: the three facts before the first failure, not after it.
  const [voiceNoticeOpen, setVoiceNoticeOpen] = useState(false);
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);
  // Whether THIS press opens a live session. The decision is `liveReading`'s and
  // nobody else's: a route that cannot stream is never quietly swapped for one
  // that can, because wanting live text is not consent to send the audio of
  // someone who chose the offline path off their machine.
  const liveWanted = useLiveWanted();
  const live = liveReading(
    {
      route: (sttStatus?.route === "hosted" ? "hosted" : "local") as LiveRoute,
      speechWorks: sttStatus?.speechWorks !== false,
    },
    // Until the status has arrived the route is unknown, and an unknown route
    // is not a licence to open a metered session.
    liveWanted && sttStatus !== null,
  );
  const voice = useVoiceInput((text) => setDraft((prev) => (prev ? `${prev} ${text}` : text)), live.active);
  const loadSttStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/stt/status");
      setSttStatus(res.ok ? ((await res.json()) as SttStatus) : null);
    } catch {
      setSttStatus(null); // an older server has no such endpoint; the sheet stays quiet
    }
  }, []);
  // Once, on mount: the live decision needs the ROUTE before the first press,
  // and an unknown route reads as "cannot stream" — which would quietly demote
  // the feature for the length of one fetch. Three file probes on the server,
  // and the sheet below is faster for it too.
  useEffect(() => {
    void loadSttStatus();
  }, [loadSttStatus]);
  // The setup case takes the microphone button away, and its tooltip with it —
  // so the sheet is the only surface left that can say why, and it must come
  // back even for a reader who dismissed it once.
  useEffect(() => {
    if (voice.micError !== null && opensTheSheet(voice.micError)) {
      void loadSttStatus();
      setVoiceNoticeOpen(true);
    }
  }, [voice.micError, loadSttStatus]);
  const reachForMic = async (): Promise<void> => {
    // A first reach opens the sheet INSTEAD of recording: nobody has agreed to
    // anything yet, and on the hosted route the first press would otherwise
    // send audio off the machine before saying that it does.
    if (voice.micError === null && shouldShowVoiceNotice(readVoiceNoticeSeen(), null, false)) {
      void loadSttStatus();
      setVoiceNoticeOpen(true);
      return;
    }
    await voice.toggleMic();
  };
  const dismissVoiceNotice = (): void => {
    // Every exit records it — card 144's lesson, learned on the other sheet.
    markVoiceNoticeSeen();
    setVoiceNoticeOpen(false);
  };

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

  // In-view search (state/search.ts): this view walks its own turns. One hit is
  // one matching TURN — the reasoning for that and for leaving thinking blocks
  // and tool bodies out of the haystack is in chatSearch.ts.
  const search = useSearch();
  const searching = search.open && search.query.trim() !== "";
  const hits = useMemo(
    () =>
      searching
        ? chatHits(
            state.turns,
            search.query,
            (turn) => {
              // The card store lives here, so flattening belongs here: the search
              // module stays free of the card's shape.
              if (turn.kind !== "tool") return undefined;
              const card = state.cards[turn.callId];
              if (card === undefined) return undefined;
              return {
                name: card.name,
                input: typeof card.input === "string" ? card.input : JSON.stringify(card.input ?? ""),
                output: card.output ?? "",
              };
            },
            search.regex,
          )
        : [],
    [searching, search.query, search.regex, state.turns, state.cards],
  );
  const hitSet = useMemo(() => new Set(hits), [hits]);
  // The store clamps its index to the count it was told, but it is told one
  // render late — clamp again here so a shrinking history never indexes past
  // the end.
  const currentHit = hits.length > 0 ? (hits[Math.min(search.index, hits.length - 1)] ?? -1) : -1;

  useEffect(() => {
    if (!search.open) return; // a closed search costs nothing; close() zeroed the count
    reportCount(hits.length);
    // The query and the mode belong here even though the body does not read
    // them: the store zeroes its count on every change to either, so an effect
    // keyed only on the number stays silent whenever two different queries
    // happen to find the same number of hits — and the readout keeps saying
    // "no matches" over a view full of them.
  }, [search.open, search.query, search.regex, hits.length]);

  // Leaving the screen (tab switch, view swap) means this view has no hits to
  // report any more. Mount-only, so a changing count never round-trips through
  // zero — that would reset the reader's position on every keystroke.
  useEffect(() => () => reportCount(0), []);

  useEffect(() => {
    if (currentHit < 0) return;
    const el = scrollRef.current?.querySelector(".chat-hit--current");
    if (el == null) return;
    // Someone stepping through hits is READING, not following the stream:
    // release the live-edge pin (card 78 #5) before the jump, or the next
    // streamed token drags them straight back down to the bottom.
    pinnedRef.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentHit]);

  /** The hit classes for a turn at flat index `i` — "" when not searching. */
  const hitClass = (i: number): string =>
    hitSet.has(i) ? (i === currentHit ? " chat-hit chat-hit--current" : " chat-hit") : "";

  // The box grows to whichever layer is taller: the draft, or the words a live
  // session is still hearing. Measuring only the textarea was the defect — its
  // value is empty while the live text is painted behind it, so a second line
  // of speech grew the box by nothing.
  // useCallback because the effect below depends on it: both refs are stable,
  // so the identity never has to change and the growth pass never re-runs for
  // a reason that is not new text.
  const autosize = useCallback((): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${composerHeight(el.scrollHeight, ghostRef.current?.scrollHeight ?? null, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, []);

  // Every partial changes how tall the ghost is, and nothing types a key while
  // it happens — so the growth pass has to be driven by the text arriving.
  // Declared after `autosize` on purpose: the hook rules read the order.
  useEffect(() => {
    autosize();
  }, [voice.provisional, autosize]);

  // Card 78 #3: running no longer blocks — App queues the message and sends
  // it when the run ends (the chips above the composer show the waiting line).
  // Card 183: `/` at the start of the composer completes an installed skill.
  // The picker gets first refusal on every key, because it owns Enter while its
  // list is open and the composer owns it the rest of the time.
  const slash = useSlashPicker(draft, liveView, (text) => {
    setDraft(text);
    const el = textareaRef.current;
    if (el !== null) {
      el.focus();
      // The caret lands after the sentence, so the reader carries straight on
      // with what they actually wanted.
      requestAnimationFrame(() => el.setSelectionRange(text.length, text.length));
    }
  });

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || !liveView) return;
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
  const micBase = micButtonState(voice.micPhase, voice.micAvailable, lang);
  // Card 187 step 1: a failure says why, on the control that failed. The button
  // keeps its own title while nothing has gone wrong, so the normal case reads
  // exactly as it always did.
  const mic =
    voice.micError === null ? micBase : { ...micBase, title: t(lang, voiceErrorKey(voice.micError)) };
  const buttons = composerButtons(
    {
      running: liveView && state.running,
      stopping: props.stopRequested === true,
      draftEmpty: draft.trim() === "",
    },
    lang,
  );

  // Subagent turns nest into thread blocks (one per child burst, stream order);
  // main turns render flat. Pure grouping over the reducer's chronological
  // list — the trace tab keeps the flat truth.
  const grouping = props.grouping ?? "v1";
  const blocks = useMemo(
    () =>
      grouping === "v2"
        ? groupTurnsV2(state.turns, state.cards, state.agents)
        : groupTurns(state.turns, state.cards, state.agents),
    [grouping, state.turns, state.cards, state.agents],
  );

  const vk = props.viewKey ?? "live";
  const renderTurn = (turn: Turn, i: number, inThread = false) => {
    switch (turn.kind) {
      case "user":
        return (
          <div key={`${vk}:${i}`} className={`user-turn${hitClass(i)}`}>
            <div className="eyebrow">{t(lang, "chat.you")}</div>
            {turn.attachments !== undefined && turn.attachments.length > 0 && (
              <div className="user-attachments">
                {turn.attachments.map((a, j) => (
                  <img
                    key={j}
                    className="user-attachment-thumb is-openable"
                    src={`data:${a.mediaType};base64,${a.dataBase64}`}
                    alt={a.name}
                    title={a.name}
                    onClick={() => openImage(a)}
                  />
                ))}
              </div>
            )}
            {/* The user's own words are a plain string here, so the literal
                occurrences get marked inside the outline. The assistant answer
                below cannot: it is markdown rendered to React elements, and
                there is no rendered string left to slice. */}
            <div className="user-text">
              {searching
                ? markSegments(turn.text, search.query).map((seg, j) =>
                    seg.mark ? (
                      <mark key={j} className="chat-mark">
                        {seg.text}
                      </mark>
                    ) : (
                      seg.text
                    ),
                  )
                : turn.text}
            </div>
          </div>
        );
      case "assistant":
        return (
          <div key={`${vk}:${i}`} className={`assistant-turn${hitClass(i)}`}>
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
                <Markdown text={turn.text} mark={searching ? search.query : undefined} />
                {liveView && state.running && i === lastIndex && (
                  <span className="caret pulse" aria-hidden="true" />
                )}
              </div>
            )}
            {/* Per-message footer: this answer's token cost + how long it took
                (from its usage event; the trace JSON carries the same numbers).
                No usage event means nothing was measured for this answer — the
                duration, the window and the model are all stamped by it — so an
                unmetered answer gets no line rather than an empty one. */}
            {turn.usage !== undefined && (
              <div className="assistant-meta tabular" title={t(lang, "chat.usageTitle")}>
                {turn.usage.inputTokens} in
                {/* The input side splits when the provider cached: the read is
                    the hit (context that rode in from the cache), the write is
                    what this request stored. The raw "in" above is only the
                    uncached remainder. Nothing reported, nothing rendered. */}
                {cacheSplit(turn.usage)
                  .map(
                    (c) =>
                      ` · ${c.tokens} ${t(lang, c.kind === "read" ? "chat.cacheRead" : "chat.cacheWrite")}`,
                  )
                  .join("")}
                {` · ${turn.usage.outputTokens} out`}
                {turn.durationMs !== undefined && ` · ${formatDuration(turn.durationMs)}`}
                {/* Card 87: the answer's wall-clock window + the model that made it. */}
                {turn.endTs !== undefined &&
                  turn.durationMs !== undefined &&
                  ` · ${clockTime(turn.endTs - turn.durationMs)} → ${clockTime(turn.endTs)}`}
                {turn.model !== undefined && ` · ${turn.model}`}
              </div>
            )}
          </div>
        );
      case "tool": {
        const card = state.cards[turn.callId];
        return card !== undefined ? (
          <ToolCard key={`${vk}:${turn.callId}`} card={card} live={liveView} inThread={inThread} />
        ) : null;
      }
      case "info":
        return (
          <div key={`${vk}:${i}`} className={`info-line ${turn.tone}`}>
            {turn.infoKey !== undefined ? t(lang, turn.infoKey, turn.infoVars) : turn.text}
          </div>
        );
      case "error":
        return (
          <div key={`${vk}:${i}`} className="error-card">
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

  // The session tools, in the bottom bar rather than floating over the first
  // message (owner, 2026-08-03). One row, built once, rendered by whichever
  // branch is on screen: a live session and an archive are equally exportable
  // and equally translatable, so they must not offer different controls.
  //
  // viewKey: without it the export cannot see that a translation is showing,
  // and would keep writing the recorded stream under a label promising the view
  // on screen. It is the same key the translate sheet is handed, one line down.
  const tools = chatTools({ events: props.events?.length ?? 0, translatedUnits: translated.byId.size });
  const toolsRow = tools.row && (
    <div className="composer-tools" role="group" aria-label={t(lang, "chat.tools")}>
      {tools.exportControl && (
        <ExportMenu kind="chat" events={props.events ?? []} label={props.sessionLabel ?? null} viewKey={vk} />
      )}
      {tools.translateControl && <TranslatePanel events={props.events ?? []} viewKey={vk} />}
      {/* The session's own files on disk. Same component as the trace's, so the
          two bars cannot drift; it draws nothing at all for a live session or a
          pasted file, which have no folder to point at. */}
      <SessionFolderButtons storePath={props.storePath ?? null} />
    </div>
  );

  // The disclosure menu, built once here for the same reason the tools row is:
  // it belongs to BOTH bars. It is the only route to the disclosure level, the
  // reading width and the chat reading, and those three say how a session is
  // read, not what it does. Reading someone else's stored session is what the
  // archive branch is for, so a menu that appears only while a run is live is
  // absent from the screen that needs it most. Not folded into the tools row:
  // that row withholds itself on an empty chat, and this control still applies
  // there. One mount, two places to render it.
  const discMenu = <DisclosureMenu />;

  return (
    <main className={`chat${chatWidth === "wide" ? " chat--wide" : ""}`} {...attachments.dropHandlers}>
      {/* Jump rail, the trace's affordance: an imported session runs to hundreds
          of turns and scrolling it by hand is not navigation. */}
      <div className="chat-rail">
        <button
          type="button"
          className="chat-rail-btn"
          title={t(lang, "trace.toStart")}
          aria-label={t(lang, "trace.toStart")}
          onClick={() => {
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            pinnedRef.current = false;
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 3.5h8" />
            <path d="M4 11.5 8 7.5l4 4" />
          </svg>
        </button>
        <button
          type="button"
          className="chat-rail-btn"
          title={t(lang, "trace.toEnd")}
          aria-label={t(lang, "trace.toEnd")}
          onClick={() => {
            const el = scrollRef.current;
            if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            pinnedRef.current = true;
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 12.5h8" />
            <path d="M4 4.5 8 8.5l4-4" />
          </svg>
        </button>
      </div>
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
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              {t(lang, "chat.emptyHint")}
            </p>
            {liveView && props.onPickFolder && (
              <WorkspaceChooser
                sendClient={props.sendClient}
                onPickFolder={props.onPickFolder}
                workspace={state.workspace}
              />
            )}
          </div>
        ) : (
          <div className="history">
            {blocks.map((b) =>
              b.kind === "turn" ? (
                renderTurn(b.turn, b.index)
              ) : b.kind === "chip" ? (
                /* v2: the child's turns are in the panel, not in the scroll.
                   The chip is the place they left, and the way back to them. */
                <div key={`${vk}:chip-${b.index}`} className="work-chip-row">
                  {props.renderChip?.(b.workIds, b.index)}
                </div>
              ) : (
                <section
                  key={`${vk}:thread-${b.agentId}-${b.items[0].index}`}
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
            {/* The waiting line (card 78 #3): queued messages as removable
                chips — they auto-send, oldest first, when the run ends. */}
            {props.queued !== undefined && props.queued.length > 0 && (
              <div className="queue-chips" role="list" aria-label={t(lang, "chat.queuedHint")}>
                {props.queued.map((m) => (
                  <span key={m.id} className="queue-chip" role="listitem" title={t(lang, "chat.queuedHint")}>
                    <span className="queue-chip-text">{m.text}</span>
                    {m.attachments !== undefined && m.attachments.length > 0 && (
                      <span className="queue-chip-att tabular">+{m.attachments.length}</span>
                    )}
                    <button
                      type="button"
                      className="queue-chip-x"
                      aria-label={t(lang, "chat.unqueue")}
                      title={t(lang, "chat.unqueue")}
                      onClick={() => props.onUnqueue?.(m.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <AttachmentPreview attachments={attachments.pending} onRemove={attachments.removeAt} />
            {voice.micPhase === "recording" && (
              /* The level meter (card 187 step 3): it moves with the voice, so
                 "it hears you" is answered by looking rather than by trying. */
              <span className="mic-meter" aria-hidden="true">
                {meterBars(voice.level).map((h, i) => (
                  <i key={i} style={{ transform: `scaleY(${h.toFixed(3)})` }} />
                ))}
              </span>
            )}
            {mic.recording && (
              <div className="recording-indicator" aria-live="polite">
                <span className="dot accent pulse" aria-hidden="true" />
                <span>{t(lang, "chat.recording", { t: formatTimer(voice.recordMs) })}</span>
              </div>
            )}
            {/* A live session that produced no transcript says which of the four
                things happened. Separate from micError on purpose: "the
                provider refused" and "you denied the microphone" are not the
                same news and must not share a sentence. */}
            {voice.liveFailed !== null && (
              <div className="recording-indicator" aria-live="polite">
                <span>{t(lang, `voice.live.${voice.liveFailed}`)}</span>
              </div>
            )}
            <div className={attachments.dragOver ? "composer-inner drag-over" : "composer-inner"}>
              {/* Card 183: anchored to .composer-inner, which is why it is the
                  positioned ancestor. It opens UPWARD like the menus in the
                  action row below — there is nothing beneath the bar. */}
              {slash.node}
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
              {/* The box (owner 2026-08-09): the full reading width of the
                  transcript above, growing with the draft, with the ONE action
                  seat inside at the bottom right — Send, or Stop while a run
                  streams and nothing new is drafted (composerButtons decides).
                  Everything else lives in the action row below. */}
              <div className="composer-box">
                {/* The field is the textarea plus, while a live session runs, a
                    ghost layer under it (card 187 step 6). The owner asked for
                    the words to arrive IN the text, and the two layers are how
                    that stays honest: the ghost repeats the draft in
                    TRANSPARENT ink so the faded part begins exactly where the
                    real text ends, and the provisional words live only there.
                    They are therefore unselectable, unsendable and not in
                    `draft` — a guess must never be one Enter away from being
                    sent as if somebody had typed it. */}
                <div className="composer-field">
                  {voice.provisional !== "" && (
                    <div className="composer-ghost" aria-hidden="true" ref={ghostRef}>
                      <span className="said">{draft}</span>
                      <span className="heard">
                        {draft === "" ? "" : " "}
                        {voice.provisional}
                      </span>
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    placeholder={
                      showsPlaceholder(draft, voice.provisional) ? t(lang, "chat.placeholder") : ""
                    }
                    aria-label={t(lang, "chat.placeholder")}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      autosize();
                    }}
                    onKeyDown={(e) => {
                      if (slash.handleKey(e)) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                </div>
                {buttons.seat === "stop" ? (
                  <button
                    type="button"
                    className="composer-seat composer-seat--stop"
                    disabled={buttons.stopDisabled}
                    aria-label={t(lang, "chat.stopAria")}
                    title={buttons.stopLabel}
                    onClick={props.onAbort}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer-seat composer-seat--send"
                    disabled={buttons.sendDisabled}
                    aria-label={buttons.sendLabel}
                    title={buttons.sendLabel}
                    onClick={submit}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 12.5v-9" />
                      <path d="M4 7.5 8 3.5l4 4" />
                    </svg>
                  </button>
                )}
              </div>
              {/* The action row (owner 2026-08-09): every control that is not
                  the draft or its seat, on the same column width. Disclosure
                  and attach keep the left end, the microphone family and the
                  gear keep the right — the same ends of the line they held
                  when they shared the row with the textarea. */}
              <div className="composer-actions">
                {/* Card 78 #4: the disclosure menu, LEFT of the first toolbox
                    button, per the owner's placement. */}
                {discMenu}
                {/* Export and translation moved down here from above the box:
                    floating over the first message they read as decoration, and
                    they belong with every other control that is not the draft
                    or its seat. */}
                {toolsRow}
                <button
                  type="button"
                  className="icon-button attach-button"
                  aria-label={t(lang, "chat.attachAria")}
                  title={t(lang, "chat.attach")}
                  onClick={attachments.openFilePicker}
                >
                  <svg
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
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <circle cx="5.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
                    <path d="M2 11l3.5-3.5L9 11l2.5-2.5L14 11" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={
                    mic.recording
                      ? "icon-button attach-button mic-button recording"
                      : "icon-button attach-button mic-button"
                  }
                  aria-label={mic.title}
                  aria-pressed={mic.recording}
                  title={mic.title}
                  disabled={mic.disabled}
                  onClick={() => void reachForMic()}
                >
                  {voice.micPhase === "recording" && (
                    /* The LED: it is listening. A dot rather than a word, beside
                       the glyph, because the answer to "does it hear me" has to
                       be readable without reading (card 187 step 5). */
                    <span className="mic-led" aria-hidden="true" />
                  )}
                  {mic.recording ? (
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                      <rect x="3" y="3" width="10" height="10" rx="1.5" />
                    </svg>
                  ) : (
                    <svg
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
                      <rect x="6" y="1.5" width="4" height="8" rx="2" />
                      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
                      <path d="M8 12v2.5M5.5 14.5h5" />
                    </svg>
                  )}
                </button>
                {/* The device picker, right beside the glyph it belongs to
                    (card 187 step 2). It opens even while the button is disabled:
                    choosing a microphone is exactly what someone does when it did
                    not work. */}
                <MicMenu choice={voice.choice} onOpen={() => void voice.refreshDevices()} />
                <ComposerGear
                  workspaceInfo={state.workspace}
                  permissionMode={state.permissionMode}
                  sendClient={props.sendClient}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="composer archive-bar">
          {/* Same column wrapper as the live branch, so the bar keeps the width
              it had. The tools sit INSIDE the bar now, next to the disclosure
              menu — same move as the live branch, so the two screens do not
              disagree about where export and translation live. */}
          <div className="composer-column">
            <div className="composer-inner">
              {/* Leftmost, as in the live bar: same control, same end of the
                  row, so the hand goes to the same place on both screens. */}
              {discMenu}
              {toolsRow}
              <span className="archive-note">{t(lang, "lab.viewingArchive")}</span>
              {props.onResume !== undefined && (
                <button
                  type="button"
                  className="soft-primary resume-btn"
                  title={t(lang, "arch.resumeTitle")}
                  onClick={props.onResume}
                >
                  {t(lang, "arch.resume")}
                </button>
              )}
              {/* Card 95: export is the mirror of the import — the stored JSONL,
                  verbatim, as a download. A plain link so the browser handles the
                  save dialog; same-origin, so the local fence sees no Origin. */}
              {props.exportId !== undefined && (
                <a
                  className="ghost archive-export"
                  href={`/api/sessions/${encodeURIComponent(props.exportId)}/export`}
                  download={`${props.exportId}.jsonl`}
                  title={t(lang, "arch.exportTitle")}
                >
                  {t(lang, "arch.export")}
                </a>
              )}
              {/* The sidecar beside that file: the recorded LLM exchanges,
                  every line labeled with its fidelity (an Anthropic response
                  is reconstructed from sdk-events, not socket bytes). Offered
                  only when the index answered non-empty, so the link never
                  names an empty file. */}
              {props.llmWireId !== undefined && (
                <a
                  className="ghost archive-export"
                  href={`/api/sessions/${encodeURIComponent(props.llmWireId)}/llm-wire`}
                  download={`${props.llmWireId}.llm.jsonl`}
                  title={t(lang, "arch.llmWireTitle")}
                >
                  {t(lang, "arch.llmWire")}
                </a>
              )}
              {props.onDelete !== undefined && <DeleteButton onDelete={props.onDelete} />}
              <button type="button" className="link" onClick={props.onReturnToLive}>
                {t(lang, "lab.returnLive")}
              </button>
            </div>
          </div>
        </div>
      )}
      {voiceNoticeOpen && (
        <VoiceNotice
          status={sttStatus}
          onDismiss={dismissVoiceNotice}
          onOpenSettings={() => {
            // The address the deep-link work already gives us (card 181), and it
            // lands on the section that holds the switch rather than the top of
            // a long pane. Recorded as seen: the reader is acting on it.
            dismissVoiceNotice();
            window.location.hash = "#/settings/stt";
          }}
        />
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

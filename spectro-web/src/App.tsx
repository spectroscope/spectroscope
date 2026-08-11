// The wiring: socket -> rAF batch -> reducer -> components. The live stream
// and a replayed archive are the same UiState shape from the same reducer;
// the app only decides which of the two the components render.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { ClientMessage, RunEvent } from "./events";
import { connect } from "./transport/ws";
import type { Connection, ConnectionStatus } from "./transport/ws";
import {
  initialState,
  normalizeReplay,
  recordOutgoing,
  recordResumeMarker,
  reduceAll,
  traceFromEvents,
  windowTrace,
} from "./state/reducer";
import type { UiState } from "./state/reducer";
import { fetchLlmWireIndex, mergeLlmExchanges } from "./wire/llmWire";
import { summarizeHistory } from "./state/resume";
import { AppHeader } from "./components/AppHeader";
import { Chat } from "./components/Chat";
import { ChatV2 } from "./components/ChatV2";
import { isFlipIntoV2, useChatView } from "./state/chatView";
import type { ChatViewMode } from "./state/chatView";
import { foldWork } from "./state/work";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ImagePanel } from "./components/ImagePanel";
import { ImportDialog } from "./components/ImportDialog";
import { GateBar } from "./components/GateBar";
import { LevelPill } from "./components/LevelPill";
import { LevelingPanel } from "./components/LevelingPanel";
import { LockedSurface } from "./components/LockedSurface";
import { LevelingIntro } from "./components/LevelingIntro";
import { useLeveling } from "./state/useLeveling";
import { isSurfaceOpen, newlyOpened, translated, levelName } from "./state/leveling";
import { setBeaconSink } from "./state/levelingBeacon";
import { formatRoute, parseAppRoute, type Route, type SettingsSection, type ViewTab } from "./state/route";
import {
  clearReportedViews,
  offerIncomingView,
  reportedViewFor,
  subscribeReportedViews,
} from "./state/viewReport";
import { navDepth, navLanded, writeRoute, type NavCause, type NavIntent } from "./state/history";
import { canGoBack, canGoForward, NAV_START, type NavDepth } from "./state/navDepth";
import {
  createNavNonce,
  pinAfterNavigation,
  planRoute,
  routeOfPlace,
  settingsCloseDecision,
  viewIdentity,
  type Place,
} from "./state/appRouter";
import { DoctorPanel } from "./components/DoctorPanel";
import { Keymap } from "./components/Keymap";
import { SearchBox } from "./components/SearchBox";
import { Onboarding } from "./components/Onboarding";
import { ONBOARDED_KEY, shouldOnboard, shouldShowOnboarding } from "./components/onboardingFlag";
import { LocalModelNotice } from "./components/LocalModelNotice";
import { LocalModelDialog } from "./components/LocalModelDialog";
import {
  markLocalNoticeSeen,
  readLocalNoticeSeen,
  shouldShowLocalNotice,
} from "./components/localNoticeFlag";
import { ScenarioDialog } from "./components/ScenarioDialog";
import { StarterDialog } from "./components/StarterDialog";
import { compile } from "./scenario/compile";
import type { Dsl } from "./scenario/dsl";
import { Sidebar } from "./components/Sidebar";
import { Resizer } from "./components/Resizer";
import { RightPanel } from "./components/RightPanel";
import { fetchSettings, putSettings } from "./state/serverSettings";
import { reasoningFrame, useReasoningChoice, wireChoice } from "./state/reasoning";
import { useReasoningCapability } from "./components/ReasoningControl";
import { enqueue, removeQueued, type QueuedMessage } from "./state/sendQueue";
import {
  openRightPanel,
  setActiveRightTab,
  setImagesW,
  setRightPanelW,
  setSidebarW,
  toggleRightPanel,
  useLayout,
} from "./state/layout";
import { TextView } from "./components/TextView";
import { textExportViewKey } from "./components/textExportClaim";
import { TraceView } from "./components/TraceView";
import { traceLinkFor } from "./observability/langfuseLink";
import { UsageFooter } from "./components/UsageFooter";
import { GraphView } from "./graph/GraphView"; // the fifth consumer
import { StateGraphPane, type LoadedRun } from "./stategraph/StateGraphPane";
import type { PendingAttachment } from "./components/AttachmentPreview";
import { SettingsPanel } from "./components/SettingsPanel";
import { ParticleField } from "./components/ParticleField";
import { LabView } from "./lab/LabView";
import { FleetLab } from "./lab/FleetLab";
import { SpectrumView } from "./spectrum/SpectrumView";
import { FleetBus } from "./spectrum/FleetBus";
import { FleetBar } from "./spectrum/FleetBar";
import { AgentFeed } from "./spectrum/AgentFeed";
import { FleetHome } from "./spectrum/FleetHome";
import { FleetLobby } from "./spectrum/FleetLobby";
import { loadSidecarAgents, NO_SIDECARS, type SidecarAgent, type SidecarIndex } from "./import/sidecarAgents";
import { detectAndLoad } from "./import/detect";
import { reportBrowserError } from "./state/browserLog";
import { FleetSpawnForm } from "./spectrum/FleetSpawn";
import {
  backToLive as labBackToLive,
  pushLive as labPushLive,
  resetLive as labResetLive,
} from "./state/stepper";
import {
  fleetPushLive,
  fleetLoadScenario,
  hydrateFleet,
  knownFleet,
  useFleet,
  useFleetHubPort,
  useFleets,
  fleetPending,
  removeFleet,
} from "./state/fleetStore";
import { swapTracePayloads, useTranslatedEvents, useTranslation } from "./state/translate";
import type { ImportSource } from "./import/detect";
import type { SubagentTranscript } from "./import/subagentFile";
import { attachSources, sourceStats } from "./state/traceSource";
import { traceProvenance } from "./components/traceDetail";
import { shownImportBar, subagentNote, type ImportBarState } from "./components/importBar";
import { collectImages, imageLines, indexOf, withSourceLines } from "./state/sessionImages";
import { useImageRequest } from "./state/imageViewer";
import { ImageLightbox } from "./components/ImageLightbox";
import { TranslateToggle } from "./components/TranslatePanel";
import { useDesignPrefs } from "./state/designPrefs";
import { useScrollReveal } from "./effects/scrollReveal";
import { t } from "./i18n/i18n";
import { useLang } from "./state/lang";

interface ConnState {
  status: ConnectionStatus;
  /** Epoch ms of the next automatic retry, when status is "closed". */
  retryAt: number | null;
}

interface Replay {
  id: string;
  state: UiState;
  /** Raw events too: the graph tab replays exactly what the reducer consumed. */
  events: RunEvent[];
  /** An import also carries the file it came from, so the trace can point at
   *  the line behind each frame. It lives here and nowhere else: an import is
   *  never written to disk (see `canResume`), and saying so is more honest than
   *  inventing a store for it. */
  source?: ImportSource;
}

// Right-panel resize clamps: the panel never shrinks below its minimum and
// the chat always keeps its reserved width.
const RIGHT_PANEL_MIN_WIDTH_PX = 260;
const CHAT_RESERVED_MIN_WIDTH_PX = 360;

/** Fold a stored session's events into a ready-to-show archive state. */
const foldArchive = (events: RunEvent[]) => normalizeReplay(reduceAll(initialState, events));

export function App() {
  const [live, setLive] = useState<UiState>(initialState);
  const [replay, setReplay] = useState<Replay | null>(null);
  // The third event source (parallel to replay): a contextId when a fleet is
  // entered, feeding the tabs that fleet's events instead of the own session.
  const [enteredFleet, setEnteredFleet] = useState<string | null>(null);
  /** The agent transcripts beside the imported session (card 177). */
  const [sidecars, setSidecars] = useState<SidecarIndex>(NO_SIDECARS);
  // The store address of the session on screen, when it has one. Card 177 uses
  // the same fact to find the sidecar agents; the folder buttons use it to ask
  // which of this session's directories exist. A paste or a picked file carries
  // no address and gets no buttons, which is honest: there is no folder.
  //
  // STAMPED WITH THE SESSION, like the import bar beside it: the reader can
  // leave an imported file without anything clearing this, and folder buttons
  // pointing at the previous session's directories would be worse than none.
  const [importedPath, setImportedPath] = useState<{ sessionId: string; path: string } | null>(null);
  // What the llm-wire index answered for the opened session (leg E): how many
  // recorded exchanges sit in the sidecar. STAMPED WITH THE SESSION like
  // `importedPath`, for the same reason — a download link pointing at the
  // previous session's sidecar would be worse than none.
  const [llmWire, setLlmWire] = useState<{ sessionId: string; count: number } | null>(null);
  /**
   * Which sidebar segment is showing — App's, not the sidebar's.
   *
   * It lived as a private `useState` inside Sidebar, so pressing `fleets`
   * re-rendered one list body and told nothing else. The whole right-hand side
   * stood still until the reader loaded something, which is what "wenn ich in
   * den Fleet Modus gehe, dann bleibt alles so, wie es ist" describes. Up here
   * the surface can answer the press: `fleets` with nothing entered opens the
   * lobby instead of leaving the last session standing.
   */
  /*
   * `stategraph` joins the pair as a third SEGMENT, not a fourth tab: a
   * session's tabs are lenses on one run's event stream, and a StateGraph is
   * not a run — its shape is fixed at compile(), before a token flows, so it
   * has nothing to be a lens on.
   *
   * Deliberately NOT in route.ts's vocabulary. `nav` is component state and an
   * address is a promise to reopen the same thing; the pane's artifacts come
   * out of a file picker, so a #/stategraph link would reopen an empty pane and
   * lie about it. Adding the word to the route would also drag routeVocabulary,
   * appRouter and the leveling ladder along, for a view that has nothing to
   * address.
   */
  const [nav, setNav] = useState<"sessions" | "fleets" | "stategraph">("sessions");
  /*
   * The artifacts the state graph is drawing — up here because the arm below
   * unmounts whenever `nav` moves off "stategraph". They lived in the pane,
   * and a reader who loaded a run, looked at a session and came back found the
   * invitation again with the run gone (measured 2026-08-11). A file pick is
   * expensive to repeat and nothing on disk remembers it, so the fact belongs
   * beside the segment that decides whether the pane is on screen at all.
   */
  const [stateGraphRun, setStateGraphRun] = useState<LoadedRun | null>(null);
  /**
   * How far back and forward this app can go — for the two buttons in the bar.
   *
   * The desktop shell has no URL bar, so it has no back button either: the one
   * control every browser view of this app has always had for free. Giving
   * imports an address (card 179) made the absence sharp, because a reader who
   * opens a workflow's agent from the work panel had nowhere to return to.
   */
  const [depth, setDepth] = useState<NavDepth>(NAV_START);
  // The hotkey handler is bound once, so it reads the depth through a ref
  // rather than closing over the first one.
  const depthRef = useRef(depth);
  depthRef.current = depth;
  const [conn, setConn] = useState<ConnState>({ status: "connecting", retryAt: null });
  // Queue-while-running (card 78 #3): messages submitted during a run wait
  // here as chips and auto-send on run_end. Session-local — a new chat or a
  // resume clears it with the fresh socket.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Stop feedback (card 78 #2): true from the stop click until the root
  // run_end flips running off — the button reads "stopping …" meanwhile.
  const [stopRequested, setStopRequested] = useState(false);
  // True from an accepted user_message until its run_start (or an error event)
  // arrives — the drain's re-entry guard for the tiny accepted-but-not-started
  // gap. A ref, not state: it flips inside the send path mid-commit.
  const awaitingRunStart = useRef(false);
  const [connNonce, setConnNonce] = useState(0); // bumped by "New chat" to force a fresh socket session
  const [resumeId, setResumeId] = useState<string | null>(null); // non-null: the socket continues this stored session
  const [refreshToken, setRefreshToken] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const layout = useLayout(); // persisted panel widths (sidebar + Lab panes)
  const [tab, setTab] = useState<ViewTab>("chat"); // chat | spectrum | graph | trace | text | lab
  /* Variant B (0.7 A/B): while a fleet is entered, its OWN bar replaces the
     app tabs — "bus" or one agent id. Reset on every fleet change. */
  const [fleetTab, setFleetTab] = useState<string>("bus");
  useEffect(() => {
    setFleetTab("bus");
  }, [enteredFleet]);
  // The ladder (card 80). Server state only: every lock is derived from the
  // snapshot on render, never cached, so a mode flipped elsewhere cannot leave
  // a stale lock behind.
  const leveling = useLeveling();
  // Held in a ref because onEvents is memoised with no dependencies; reading the
  // callback fresh here is the same stale-closure guard providerModelField uses.
  const refreshLeveling = useRef(leveling.refresh);
  refreshLeveling.current = leveling.refresh;
  const beaconRef = useRef(leveling.visit);
  beaconRef.current = leveling.visit;
  // Components too deep for a prop report through the module beacon; the app is
  // the only thing that knows where those reports should go.
  useEffect(() => {
    setBeaconSink((surface, sessionId) => beaconRef.current(surface, sessionId ?? null));
    return () => setBeaconSink(null);
  }, []);
  const [levelPanelOpen, setLevelPanelOpen] = useState(false);
  const [levelUp, setLevelUp] = useState<{ level: number; opened: string[] } | null>(null);
  const lastLevel = useRef<number | null>(null);
  const levelSnapshot = leveling.snapshot;
  useEffect(() => {
    if (!levelSnapshot) return;
    const before = lastLevel.current;
    lastLevel.current = levelSnapshot.level;
    // First read of the session is not a climb, and a reset walking back down
    // is not one either.
    if (before === null || levelSnapshot.level <= before) return;
    setLevelUp({
      level: levelSnapshot.level,
      opened: newlyOpened(levelSnapshot.ladder, before, levelSnapshot.level),
    });
    const clear = setTimeout(() => setLevelUp(null), 7000);
    return () => clearTimeout(clear);
  }, [levelSnapshot]); // spectrum = fleet lanes; trace = wire view; text = readable feed + raw JSONL; lab = step-through Flow map
  // Spectrum -> Trace hand-off: clicking a lane pins its agent as the trace's
  // agent filter (null = all agents). The chip row in the trace clears it.
  const [traceAgent, setTraceAgent] = useState<string | null>(null);
  // A Spectrum-band click hands one exact event to the Trace (open + flash it).
  const [focusEvent, setFocusEvent] = useState<RunEvent | null>(null);
  // chat-v2 (PROTOTYPE): which reading the chat is in, and which work item the
  // transcript's chip is pointing at.
  const chatView = useChatView();
  const [workHighlight, setWorkHighlight] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]); // raw, for the graph
  // Card 89: bumped per rAF batch that carried a disk-relevant event — the
  // Files tab refetches (throttled) instead of waiting for a manual reload.
  const [fsTick, setFsTick] = useState(0);
  // Provider/model, thinking and the image backend now live in the user's
  // server-side settings (~/.spectro/settings.json) — the server builds every
  // connection's agent straight from them. The useState seeds below are only
  // the harness's hardcoded BOOTSTRAP fallback until the settings-hydration
  // effect (below, near the /api/config fetch) pulls the real values once the
  // socket is open. An image-backend flip still writes the user scope
  // (changeImageProvider below), which shapes the default for the NEXT
  // session — and also latches controlsTouched so a later reconnect never
  // overwrites what the user just chose. thinking only DISPLAYS here (the
  // right panel's context line); its control moved into the model picker
  // (card 88), which mirrors the server's visibility coupling on send.
  const [imageProvider, setImageProvider] = useState("gemini");
  const [imagesOpen, setImagesOpen] = useState(false); // gallery panel
  const [thinking, setThinking] = useState(true); // reasoning visibility (on by default)
  const [settingsOpen, setSettingsOpen] = useState(false); // design drawer
  const [doctorOpen, setDoctorOpen] = useState(false); // calibration/status page
  const [keymapOpen, setKeymapOpen] = useState(false); // the ? shortcut sheet (edu port)
  const [spawnDialogOpen, setSpawnDialogOpen] = useState(false); // start a fleet node from the sidebar
  const [onboardingOpen, setOnboardingOpen] = useState(false); // first-run backend info sheet
  // Built-in model first-use notice (card 91): opens once when spectro-local
  // becomes the ACTIVE backend (wire truth); "got it" persists the dismissal.
  const [localNoticeOpen, setLocalNoticeOpen] = useState(false);
  const [localChooserOpen, setLocalChooserOpen] = useState(false); // the built-in model chooser, opened from onboarding
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try {
      return !shouldOnboard(localStorage.getItem(ONBOARDED_KEY));
    } catch {
      /* storage blocked (tests, private mode) — treat as not dismissed */
      return false;
    }
  });
  // Global keymap shortcut: ? opens the sheet, Escape closes it. Guarded while
  // typing so it never eats a keystroke in the composer or a filter (edu port).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing =
        el !== null &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      // The browser's own back/forward, for the shell that draws no chrome for
      // them. Checked BEFORE the modifier bail below, because the modifier is
      // the point — and only when the app has somewhere to go, so a reader at
      // the start of his history keeps whatever else Cmd+← means to him.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !typing) {
        if (e.key === "ArrowLeft" && canGoBack(depthRef.current)) {
          e.preventDefault();
          window.history.back();
          return;
        }
        if (e.key === "ArrowRight" && canGoForward(depthRef.current)) {
          e.preventDefault();
          window.history.forward();
          return;
        }
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeymapOpen(true);
      } else if (e.key === "Escape") {
        setKeymapOpen(false);
        setLevelPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [serverCfg, setServerCfg] = useState<{ provider: string; model: string } | null>(null); // /api/config boot truth
  // Per-provider onboarding status from /api/config (ready | needs-key | local),
  // so the picker shows 'add a key to .env' instead of a fake list.
  const [providerStatus, setProviderStatus] = useState<Record<string, string> | null>(null);
  const [configNonce, setConfigNonce] = useState(0); // bump to re-read /api/config after a key is saved
  // Key PRESENCE per image backend (from /api/config, never values). Drives
  // the gallery dropdown's "no key in .env" hints and the smart default below.
  const [imageKeys, setImageKeys] = useState<{ gemini: boolean; openai: boolean } | null>(null);
  // Latches to true the FIRST time this tab's own thinking toggle or image-
  // backend picker is touched (manually, this session) — from then on the
  // settings-hydration effect below must never clobber the user's choice,
  // even across a reconnect.
  const controlsTouched = useRef(false);
  const connRef = useRef<Connection | null>(null);
  const chatRowRef = useRef<HTMLDivElement>(null); // anchor for the right-panel resizer math

  // The right-docked panel (agents + system context) is resized from its left
  // edge: width = distance from the pointer to the row's right edge.
  const resizeRightPanel = (clientX: number): void => {
    const r = chatRowRef.current?.getBoundingClientRect();
    if (r)
      setRightPanelW(
        Math.max(RIGHT_PANEL_MIN_WIDTH_PX, Math.min(r.right - clientX, r.width - CHAT_RESERVED_MIN_WIDTH_PX)),
      );
  };

  // The gallery resizes from its left edge too (owner 2026-07-20): width =
  // distance from the pointer to the panel's own right edge — the edge is
  // stable during the drag (whatever sits right of the gallery is fixed).
  const resizeImages = (clientX: number): void => {
    const panel = chatRowRef.current?.querySelector(".image-panel");
    const row = chatRowRef.current?.getBoundingClientRect();
    const r = panel?.getBoundingClientRect();
    if (r && row)
      setImagesW(Math.max(240, Math.min(r.right - clientX, row.width - CHAT_RESERVED_MIN_WIDTH_PX)));
  };

  // Design switcher: the live (draft) skin drives the particle backdrop and the
  // scroll-reveal hook. The skin itself is already on <html> via the store.
  const { prefs: designPrefs } = useDesignPrefs();
  useScrollReveal(designPrefs.scroll);
  const lang = useLang(); // UI-chrome language; chat content keeps its own

  // One setState per animation-frame batch: n events, one React render.
  // The same batch is kept raw — the graph tab is just another reducer.
  // This state is the one the socket grows without an end in sight, so it is
  // also the one whose trace is a window; every other fold here is finite.
  const onEvents = useCallback((batch: RunEvent[]) => {
    setLive((s) => windowTrace(reduceAll(s, batch)));
    setLiveEvents((prev) => [...prev, ...batch]);
    labPushLive(batch); // the Lab's dam collects the same stream (no-op in replay)
    fleetPushLive(batch); // the fleet store splits out fleet_roster/fleet_event
    // Card 89: a tool result or a run end may have changed the workspace on
    // disk — nudge the Files tab (it throttles + dedupes on its side).
    if (
      batch.some((e) => {
        const type = (e as { type?: string }).type;
        return type === "tool_result" || type === "run_end" || type === "workspace_info";
      })
    ) {
      setFsTick((n) => n + 1);
    }
    // The ladder's server-side marks (a finished run settles first light) arrive
    // without the client asking, so a run end is the moment to re-read it. Same
    // shape as the Files nudge above, and cheaper than a socket frame nobody
    // else needs.
    if (batch.some((e) => (e as { type?: string }).type === "run_end")) {
      refreshLeveling.current();
    }
  }, []);

  useEffect(() => {
    // A fresh socket is a fresh session — waiting chips, the drain latch and
    // the stop feedback belong to the old one (card 78). Harmless on mount.
    setQueue([]);
    setStopRequested(false);
    awaitingRunStart.current = false;
    const connection = connect({
      onEvents,
      resume: resumeId ?? undefined, // ?resume=<id>: the server reloads the JSONL history
      onStatus: (status, retryDelayMs) =>
        setConn({
          status,
          retryAt: status === "closed" && retryDelayMs !== undefined ? Date.now() + retryDelayMs : null,
        }),
    });
    connRef.current = connection;
    void hydrateFleet(); // seed the roster from REST; live frames take over
    return () => {
      connRef.current = null;
      connection.close();
    };
  }, [connNonce, resumeId, onEvents]);

  // When a run finishes, a new JSONL file exists — refresh the sidebar list.
  const running = live.running;
  useEffect(() => {
    if (!running) setRefreshToken((n) => n + 1);
  }, [running]);

  // Card 78: run transitions release the stop feedback and the drain latch.
  useEffect(() => {
    if (running) {
      awaitingRunStart.current = false; // run_start arrived — the send gap is closed
    } else {
      setStopRequested(false); // run_end arrived (or nothing runs) — stop visibly took
    }
  }, [running]);
  // An error event releases the latch too: a send the server refused (or a run
  // that died before run_start) must not jam the queue until a reload. The
  // latch is a ref (synchronous reads in the send path), so the release alone
  // would not re-run the drain effect — the kick state makes it reactive
  // (review find F2: a queued chip stalled until some unrelated dep changed).
  const [drainKick, setDrainKick] = useState(0);
  const errorTurns = live.turns.reduce((n, turn) => (turn.kind === "error" ? n + 1 : n), 0);
  useEffect(() => {
    awaitingRunStart.current = false;
    setDrainKick((k) => k + 1);
  }, [errorTurns]);

  // The ONE place client frames leave the app: every outgoing ClientMessage
  // is traced (dir "out") — but only when it actually hit the wire; send()
  // returns false while the socket is down and dropped frames never crossed.
  const sendClient = useCallback((msg: ClientMessage): boolean => {
    const sent = connRef.current?.send(msg) === true;
    if (sent) {
      // Outbound rows land in the same growing array as inbound ones, so they
      // are windowed by the same rule — a chatty sender cannot outgrow it.
      setLive((s) => windowTrace(recordOutgoing(s, msg)));
      // Leveling beacons ride here rather than in each component: this is the one
      // place every client message passes, so a gate answered from the bar, the
      // lab or a fleet all report the same way, and a future sender gets it free.
      // Both acts are things the event stream cannot tell apart on its own — the
      // core emits the same permission events for an allowlist auto-approval.
      if (msg.type === "permission_response") beaconRef.current("gate");
      if (msg.type === "set_permission_mode") beaconRef.current("permission-mode");
    }
    return sent;
  }, []);

  // the frame carries the bytes ({ mediaType, dataBase64 }); the
  // thumbnails are parked in the state and picked up by the run_start case —
  // the reducer builds the user bubble, so there is no local echo turn.
  const sendNow = useCallback(
    (text: string, attachments?: PendingAttachment[]): boolean => {
      const sent = sendClient({
        type: "user_message",
        text,
        ...(attachments !== undefined && attachments.length > 0
          ? { attachments: attachments.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) }
          : {}),
      });
      if (sent && attachments !== undefined && attachments.length > 0) {
        const parked = attachments.map(({ name, mediaType, dataBase64 }) => ({
          name,
          mediaType,
          dataBase64,
        }));
        setLive((s) => ({ ...s, outboxAttachments: parked }));
      }
      if (sent) {
        // Latched until the server's run_start (or an error event) — the drain
        // must not fire again in the accepted-but-not-yet-started gap.
        awaitingRunStart.current = true;
      }
      return sent;
    },
    [sendClient],
  );
  // Queue-while-running (card 78 #3): the composer never locks. A submit
  // during a run (or while the socket is down, or while a queued send is in
  // flight) waits in the queue; the drain effect below sends it the moment
  // the session is free. Order is preserved — the queue is the only waiting
  // line, the direct path exists just to keep idle sends chip-flash-free.
  const send = (text: string, attachments?: PendingAttachment[]): void => {
    // queue.length in the guard: while chips wait, a new submit must join the
    // line, never jump it (review find F2 — order stays submission order).
    if (live.running || awaitingRunStart.current || conn.status !== "open" || queue.length > 0) {
      setQueue((q) => enqueue(q, text, attachments));
      return;
    }
    sendNow(text, attachments);
  };
  const abort = (): void => {
    // The visible half of stop (card 78 #1/#2): the button disarms to
    // "stopping …" until the root run_end actually flips running off — but
    // ONLY when the abort frame actually hit the wire. A flapped socket
    // drops the frame (send() returns false) and a latched "stopping …"
    // would disarm the button forever (review find F1).
    const sent = sendClient({ type: "abort" });
    if (sent && live.running) {
      setStopRequested(true);
    }
  };
  // The queue drain: the moment the session is free (and the socket open), the
  // next waiting message goes out. The latch guards the accepted-but-not-yet-
  // started gap; a failed send keeps its chip for the next attempt.
  const connOpen = conn.status === "open";
  useEffect(() => {
    if (!connOpen || live.running || awaitingRunStart.current || queue.length === 0) {
      return;
    }
    const next = queue[0];
    if (sendNow(next.text, next.attachments)) {
      setQueue((q) => removeQueued(q, next.id));
    }
  }, [connOpen, live.running, queue, sendNow, drainKick]);
  const unqueue = (id: number): void => {
    setQueue((q) => removeQueued(q, id));
  };
  const decide = (
    callId: string,
    allowed: boolean,
    opts?: { remember?: boolean; persist?: boolean },
  ): void => {
    sendClient({
      type: "permission_response",
      callId,
      allowed,
      remember: opts?.remember,
      persist: opts?.persist,
    });
  };
  // the provider choice lives client-side AND on the session — the
  // send() no-ops (returns false) while the socket is down, which is fine:
  // the next generate_image call simply keeps the server's current default.
  // The user-settings write is fire-and-forget: it only shapes future
  // sessions, so a failed write must never block THIS session's switch.
  const changeImageProvider = (provider: string): void => {
    controlsTouched.current = true; // a manual choice must never be overwritten by a later hydration
    setImageProvider(provider);
    sendClient({ type: "set_image_provider", provider });
    // drop any model left over from the other backend — a gemini model would
    // 404 against openai's endpoint (the settings panel resets it the same way).
    putSettings("user", { imageProvider: provider, imageModel: null }).catch(() => {});
  };
  // Card 88: the picker's reasoning choice rides the run. The store keeps one
  // choice per (provider, model) — both ReasoningControl hosts only WRITE the
  // store; this effect is the one wire site. It fires when the socket opens
  // (reconnect included), when the active pair changes (a confirmed provider
  // switch applies the new pair's choice — or clears the old one) and when the
  // choice itself flips. A connection that never saw a non-default choice gets
  // NO frame: an unprompted "default" would stomp the server's own thinking
  // default (set_reasoning re-seeds visibility server-side).
  // The record rules the wire as well as the seg: a stored choice is clamped
  // against the ACTIVE pair's capability record before it is spent, so a
  // choice that outlived its record (an overlay that narrowed the ladder, a
  // table change between releases) can never send a field the seg no longer
  // offers. An unknown record spends nothing, exactly as it renders nothing.
  const liveProvider = live.providerInfo?.provider ?? serverCfg?.provider ?? "";
  const liveModel = live.providerInfo?.model ?? serverCfg?.model ?? "";
  const liveCap = useReasoningCapability(liveProvider, liveModel);
  const storedChoice = useReasoningChoice(liveProvider, liveModel);
  // Memoized: the effect below compares by reference, and wireChoice may mint
  // a clamped object.
  const liveChoice = useMemo(() => wireChoice(liveCap, storedChoice), [liveCap, storedChoice]);
  const reasoningSent = useRef(false);
  useEffect(() => {
    if (conn.status !== "open") {
      reasoningSent.current = false; // a fresh connection starts clean server-side
      return;
    }
    if (liveProvider === "" || liveModel === "") return;
    if (liveChoice.mode === "default" && !reasoningSent.current) return;
    if (sendClient(reasoningFrame(liveChoice))) {
      reasoningSent.current = liveChoice.mode !== "default";
      if (liveChoice.mode !== "default") controlsTouched.current = true;
      // Mirror onSetReasoning exactly: "off" hides the stream, everything
      // else re-enables visibility — the panel's Thinking line stays honest.
      setThinking(liveChoice.mode !== "off");
    }
  }, [conn.status, liveProvider, liveModel, liveChoice, sendClient]);
  // Switch the LLM backend mid-session. Deliberately NOT optimistic: the chip
  // only flips when the server answers with a provider_info frame — a refused
  // switch (e.g. anthropic without a key) must never leave a lying chip. Only
  // the CONFIRMED switch (the frame after our own request) is written back to
  // the user settings, fire-and-forget — the frame itself stays the session
  // truth regardless of whether that write lands.
  const providerSavePending = useRef(false);
  const changeProvider = (provider: string, model: string): void => {
    providerSavePending.current = true;
    sendClient({ type: "set_provider", provider, ...(model ? { model } : {}) });
  };
  const confirmedProviderInfo = live.providerInfo;
  useEffect(() => {
    if (providerSavePending.current && confirmedProviderInfo !== null) {
      providerSavePending.current = false;
      putSettings("user", {
        provider: confirmedProviderInfo.provider,
        model: confirmedProviderInfo.model,
      }).catch(() => {});
    }
  }, [confirmedProviderInfo]);

  useEffect(() => {
    if (shouldShowLocalNotice(readLocalNoticeSeen(), live.providerInfo?.provider ?? null)) {
      setLocalNoticeOpen(true);
    }
  }, [live.providerInfo]);
  // Card 144: one handler for all four ways out of the sheet — every exit
  // records the dismissal, and Settings keeps the deliberate way back.
  const dismissLocalNotice = (): void => {
    setLocalNoticeOpen(false);
    markLocalNoticeSeen();
  };

  // The active LLM backend (provider + model) for the header and the Lab map.
  // /api/config is the boot truth; a switch overrides it optimistically.
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (alive && c && typeof c.provider === "string")
          setServerCfg({ provider: c.provider, model: c.model ?? "" });
        // Older servers do not report key presence — leave null (no hints)
        // rather than claiming "no key" against a server that never said so.
        if (alive && c && typeof c.geminiKey === "string") {
          setImageKeys({ gemini: c.geminiKey === "true", openai: c.openaiKey === "true" });
        }
        // Older servers do not report provider status — leave null (no hints).
        if (alive && c && c.providerStatus && typeof c.providerStatus === "object") {
          setProviderStatus(c.providerStatus as Record<string, string>);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [configNonce]);

  // First-run backend sheet: shown only when it hasn't been dismissed AND the boot
  // provider is unusable (needs-key) — a configured/ready setup never sees it, and
  // saving a key auto-dismisses it. Readiness-gated because the localStorage flag
  // alone is fragile (per-origin, blocked in the desktop shell).
  useEffect(() => {
    // The ladder's intro asks first. Two welcome dialogs stacked on a first run
    // is the wall this wave exists to remove, so the backend sheet waits its turn.
    const introPending = leveling.snapshot ? !leveling.snapshot.introSeen : false;
    setOnboardingOpen(
      !introPending && shouldShowOnboarding(onboardingDismissed, serverCfg?.provider ?? null, providerStatus),
    );
  }, [onboardingDismissed, serverCfg, providerStatus, leveling.snapshot]);

  // Settings hydration: the thinking toggle and the image-backend picker seed
  // from a hardcoded fallback (see the useState calls above) until the
  // server's REAL settings are known. Every time the socket transitions to
  // "open" (the first connect, and every reconnect), pull GET /api/settings
  // once and adopt its effective thinking/imageProvider — fire-and-forget,
  // a failed fetch just leaves the current values standing. Deliberately
  // skipped once controlsTouched is set: a manual flip earlier this session
  // must never be clobbered by a later reconnect (e.g. after "New chat" or a
  // dropped connection) re-applying a now-stale server default.
  useEffect(() => {
    if (conn.status !== "open" || controlsTouched.current) return;
    fetchSettings()
      .then((view) => {
        if (controlsTouched.current) return; // touched while the fetch was in flight
        if (typeof view.effective.thinking === "boolean") setThinking(view.effective.thinking);
        if (typeof view.effective.imageProvider === "string") setImageProvider(view.effective.imageProvider);
      })
      .catch(() => {});
  }, [conn.status]);

  // Smart image-backend default (owner 2026-07-20): when the user has not
  // touched the picker and the configured backend has NO key while the other
  // one has, pre-select the one that can actually generate — session-only
  // (no settings write, controlsTouched stays false so hydration still wins
  // if the server later reports a real choice). Both keyless: leave as is,
  // the dropdown labels carry the hint.
  useEffect(() => {
    if (imageKeys === null || controlsTouched.current) return;
    const other = imageProvider === "gemini" ? "openai" : "gemini";
    const has = (p: string): boolean => (p === "gemini" ? imageKeys.gemini : imageKeys.openai);
    if (!has(imageProvider) && has(other)) {
      setImageProvider(other);
      sendClient({ type: "set_image_provider", provider: other });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKeys, imageProvider, conn.status]);

  // ---- Deep links (card 131): the hash is the address of what is shown ----
  // The pure decisions live in state/appRouter (the facet diff, the nonce, the
  // settings-close verdict) and state/history (push/replace/none); here is
  // only the execution against this component's state.
  const navNonce = useRef(createNavNonce()).current;
  // The last route string this app DISPATCHED — set synchronously before any
  // async work, never derived from app state (which lags a fetch and would let
  // the hashchange+popstate double-fire of one back-press through twice).
  const lastApplied = useRef<string | null>(null);
  // Whether the CURRENT settings entry is one this app pushed: tracked at the
  // push, never guessed from history, so close knows back() from close().
  const settingsPushed = useRef(false);
  // The section a #/settings/{section} deep link named, for scroll-into-view.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  // What is on screen, as the planner needs it — a ref because follow() runs
  // outside the render (hash events) and after awaits.
  const placeRef = useRef<Place>({
    replayId: null,
    importPath: null,
    enteredFleet: null,
    tab: "chat",
    settingsOpen: false,
  });
  // The address of the transcript on screen, when it has one. Derived here
  // rather than lower down because placeRef needs it: without it a tab flip on
  // an imported session writes a session route carrying `import:<kind>:<label>`,
  // which formatRoute refuses, and the deep link is gone.
  //
  // Stamped with the session, like the import bar beside it: a reader can leave
  // an imported file without anything clearing this, and an address pointing at
  // the previous transcript is worse than none.
  const shownStorePath =
    importedPath !== null && importedPath.sessionId === (replay?.id ?? null) ? importedPath.path : null;
  // How the visible view is being read, straight from the module store the two
  // views report into (card 181). Subscribed rather than lifted into App state,
  // so a spectrum drag re-renders on its own terms and this only wakes when the
  // reading it publishes actually changed.
  const reportedView = useSyncExternalStore(
    subscribeReportedViews,
    () => reportedViewFor(tab),
    () => reportedViewFor(tab),
  );
  placeRef.current = {
    replayId: replay?.id ?? null,
    importPath: shownStorePath,
    enteredFleet,
    tab,
    settingsOpen,
    view: reportedView,
  };
  const fleetsLocked = leveling.snapshot ? !isSurfaceOpen(leveling.snapshot, "fleets") : false;
  const fleetsLockedRef = useRef(fleetsLocked);
  fleetsLockedRef.current = fleetsLocked;
  const replayRef = useRef<Replay | null>(null);
  replayRef.current = replay;
  const currentAppRoute = (): Route => routeOfPlace(placeRef.current);
  // The one writer: every write also stamps lastApplied, so a later back onto
  // this very entry is recognized as a route to apply, not an echo to skip.
  const commitUrl = (route: Route, cause: NavCause): NavIntent => {
    // Reading the depth AFTER the write: writeRoute is the only thing that
    // pushes, so it is the only thing that can move us.
    queueMicrotask(() => setDepth(navDepth()));
    lastApplied.current = formatRoute(route);
    return writeRoute(route, cause);
  };

  // Replay: fetch the stored events and push them through the SAME reducer.
  // A route application passes its cause and the tab the address resolved to
  // (applied HERE, after the fetch lands, so the leveling beacons read the
  // session actually shown); a gesture passes neither and keeps the current
  // tab. The nonce makes rapid navigations last-wins: a slow fetch a later
  // navigation overtook drops its result instead of committing a stale view.
  const openSession = async (
    id: string,
    atEvent?: number | null,
    opts?: { tab?: ViewTab | null; cause?: NavCause },
  ): Promise<void> => {
    const cause: NavCause = opts?.cause ?? "gesture";
    const ticket = navNonce.issue();
    try {
      // The llm-wire index rides along: its frames are socket-only, so a
      // reopened file's fold has no exchange rows — the index brings them
      // back, merged by ts and deduped by xid (wire/llmWire.ts). An empty
      // answer (no sidecar, an older server) merges nothing and offers no link.
      const [res, wire] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(id)}/events`),
        fetchLlmWireIndex(id),
      ]);
      if (!res.ok) throw new Error(String(res.status));
      const events = (await res.json()) as RunEvent[];
      if (!navNonce.isCurrent(ticket)) return; // a later navigation already won
      const folded = foldArchive(events);
      setReplay({
        id,
        state: wire.length === 0 ? folded : { ...folded, trace: mergeLlmExchanges(folded.trace, wire) },
        events,
      });
      setLlmWire(wire.length === 0 ? null : { sessionId: id, count: wire.length });
      setEnteredFleet(null);
      beaconRef.current("session", id);
      // A deep link resolves its index against the events as STORED, then hands
      // the event itself to the existing focus seam. An index past the end (a
      // stale link, a rewritten file) simply opens the session unseeked: landing
      // on the wrong frame would be worse than landing on none.
      let landedTab: ViewTab = opts?.tab ?? placeRef.current.tab;
      if (atEvent !== null && atEvent !== undefined) {
        const target = events[atEvent];
        if (target) {
          setFocusEvent(target);
          landedTab = opts?.tab ?? "trace";
        }
      }
      if (landedTab !== placeRef.current.tab) setTab(landedTab);
      if (cause === "gesture") {
        commitUrl(
          {
            kind: "session",
            sessionId: id,
            eventIndex: atEvent ?? null,
            tab: landedTab === "chat" ? null : landedTab,
          },
          "gesture",
        );
      }
    } catch {
      // Server unreachable or session gone — stay on the current view. An
      // APPLIED address that named nothing real must not keep lying in the
      // bar, so it is corrected to the place actually shown.
      if (!navNonce.isCurrent(ticket)) return;
      if (cause === "apply") commitUrl(currentAppRoute(), "apply");
    }
  };

  // The state half of leaving for the live view — shared by the gesture below
  // and by route application (which writes no URL of its own).
  const leaveToLiveCore = (): void => {
    navNonce.issue(); // outdate any in-flight session open
    setReplay(null);
    setEnteredFleet(null);
  };

  const returnToLive = (): void => {
    leaveToLiveCore();
    commitUrl({ kind: "live", tab: tab === "chat" ? null : tab }, "gesture");
  };

  // The state half of entering a fleet — shared by the gesture below and by
  // route application, which must NOT report a fleet visit: a pasted
  // #/fleet/{id} is an address resolving, not the operator reaching the
  // fleet surface (the plan's enter-fleet lands here, beaconless).
  const applyFleet = (contextId: string): void => {
    navNonce.issue(); // outdate any in-flight session open
    setReplay(null);
    setEnteredFleet(contextId);
    setTraceAgent(null);
    // The sidebar follows the surface. A pasted #/fleet/{id} used to enter the
    // fleet while the segment still read "Sessions", because the segment was a
    // useState inside the sidebar that nothing outside could reach.
    setNav("fleets");
    setTab("spectrum");
  };

  // Enter a fleet like a session (the gesture): its events feed the tabs; land
  // on Spectrum so the agents are visible at once, and clear any single-agent
  // trace filter. A scenario fleet's contextId writes "#/" — replays have no
  // address, so the URL never carries a scenario:* id through the fleet door.
  const enterFleet = (contextId: string): void => {
    applyFleet(contextId);
    beaconRef.current("fleet", contextId);
    commitUrl({ kind: "fleet", contextId }, "gesture");
  };

  // A view tab chosen by hand: the flip plus its address — the tab suffix on
  // a session, the bare tab on the live view, and no tab vocabulary at all on
  // a fleet landing (the write is a no-op there).
  // The address keeps up with the reading (card 181). The intent is always a
  // replace, because navigationIntent recognises a view-only move as one; that
  // is what keeps a zoom drag from burying the place a reader came from under
  // an entry per frame. Settings lie OVER the view, so nothing is written while
  // they are open or the panel's own address would be overwritten.
  const lastReported = useRef<string>("");
  useEffect(() => {
    if (settingsOpen) return;
    const target = formatRoute(currentAppRoute());
    if (target === lastReported.current) return;
    lastReported.current = target;
    commitUrl(currentAppRoute(), "gesture");
  });

  // A different transcript under the views: every reading is dropped. Row 12 of
  // one session addresses nothing in the next, and a window fitted to one run's
  // clock means nothing against another's.
  const shownIdentity = `${replay?.id ?? ""}|${shownStorePath ?? ""}|${enteredFleet ?? ""}`;
  const lastIdentity = useRef(shownIdentity);
  useEffect(() => {
    if (lastIdentity.current === shownIdentity) return;
    lastIdentity.current = shownIdentity;
    clearReportedViews();
  }, [shownIdentity]);

  const changeTab = (next: ViewTab): void => {
    setTab(next);
    // routeOfPlace already knows every one of these cases, INCLUDING the import
    // one that this branch got wrong. Writing the rule twice is how they came
    // apart: the planner's copy learned about imports and this one did not.
    commitUrl(routeOfPlace({ ...placeRef.current, tab: next }), "gesture");
  };

  // Settings open/close, with history manners (card 131). Open pushes one
  // entry and remembers having done so; close goes history.back() ONLY for
  // that entry (the popstate follow closes the panel — a facet diff, so the
  // view beneath is not refetched). A deep-linked settings page has no app
  // entry behind it: it closes in place and corrects the bar. Opening by
  // route stays write-free settings-wise — the card-121 guard in the panel
  // holds for every opener.
  const openSettingsPage = (): void => {
    setSettingsOpen(true);
    setSettingsSection(null);
    if (commitUrl({ kind: "settings", section: null }, "gesture") === "push") {
      settingsPushed.current = true;
    }
  };
  const closeSettings = (): void => {
    const decision = settingsCloseDecision(
      parseAppRoute(window.location.hash).kind === "settings",
      settingsPushed.current,
    );
    settingsPushed.current = false;
    setSettingsOpen(false);
    setSettingsSection(null);
    if (decision.verb === "back") {
      window.history.back();
    } else if (decision.rewrite) {
      commitUrl(currentAppRoute(), "apply");
    }
  };

  // Late lock arrival: the leveling snapshot lands AFTER boot, so a fleet deep
  // link can apply before the ladder says fleets are locked. Enforcement is
  // continuous — a locked home holds no entered fleet, however it got in.
  useEffect(() => {
    if (fleetsLocked && enteredFleet !== null) {
      leaveToLiveCore();
      commitUrl({ kind: "live", tab: null }, "apply");
    }
    // A home that locks fleets late must not strand the reader in a segment it
    // will not let him open. Leaving the segment is separate from leaving a
    // fleet: a locked home with nothing entered still has to come back.
    if (fleetsLocked) setNav("sessions");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetsLocked, enteredFleet]);

  // Session import (spectroscope JSONL or an adapted Claude Code transcript): the
  // loaded stream takes the SAME replay path as a stored session.
  const [importOpen, setImportOpen] = useState(false);
  // What the loaded file was, in its own numbers. Shown for EVERY import: until
  // now only a VS Code export said anything, so a Claude Code transcript was
  // labelled "Archive" and read as a session this machine had produced.
  const [importBar, setImportBar] = useState<ImportBarState | null>(null);
  // The bar belongs to the loaded file, so it goes when that file does. Found
  // live: import a transcript, click a stored session, and the bar kept naming
  // the import while the header already said archive.
  const shownBar = shownImportBar(importBar, replay?.id ?? null);

  /**
   * Open one agent's own transcript, from beside the session (card 177).
   *
   * The body arrives NOW, not at import time: one file, on the gesture that
   * asks for it. The reader is already looking at the row that names it, so
   * there is no second import gesture — this is the row opening, not a new
   * import. It travels the ordinary import path, which is what makes the agent
   * readable in the same faces as everything else (card 152 taught that path
   * to read an `agent-*.jsonl` as a session in its own right).
   */
  const openStoreTranscript = (path: string, label: string, cause: NavCause): void => {
    void fetch(`/api/claude/transcripts/content?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((raw) => {
        const { events, kind, source, subagent } = detectAndLoad(raw);
        openImport(events, label, kind, source, subagent, path, cause);
      })
      .catch((e) => reportBrowserError("store-open", e));
  };

  const openSidecarAgent = (agent: SidecarAgent): void => {
    openStoreTranscript(agent.path, `agent-${agent.agentId}`, "gesture");
  };

  const openImport = (
    events: RunEvent[],
    label: string,
    kind: "spectroscope" | "claude-code" | "vscode-agent",
    source: ImportSource,
    subagent?: SubagentTranscript,
    storePath?: string,
    /** "gesture" pushes a history entry; "apply" replaces it, so following an
     *  address does not stack a second one on top of itself. */
    cause: NavCause = "gesture",
  ): void => {
    navNonce.issue(); // an import supersedes any in-flight session open
    // Card 177: ask what sits BESIDE the file, before anything is rendered.
    // One directory listing, no transcript read — the bodies come later, one
    // at a time, when a reader opens a row. A file with no address (a paste, a
    // picked file) has nothing to ask about and keeps the empty index, which
    // is also what every failure answers: a panel that cannot reach the store
    // must say what it always said, never that a session has no agents.
    const sessionId = `import:${kind}:${label}`;
    setSidecars(NO_SIDECARS);
    setImportedPath(storePath === undefined ? null : { sessionId, path: storePath });
    if (storePath !== undefined) void loadSidecarAgents(storePath).then(setSidecars);
    setReplay({
      id: sessionId,
      state: foldArchive(events),
      events,
      source,
    });
    setEnteredFleet(null); // an import is a session view — leave any entered fleet
    setImportOpen(false);
    // A file from the STORE is an address; a paste and a picked file are not,
    // and say so by carrying no path. That distinction stopped being academic
    // when a session's agents became openable (card 177): a reader opened a
    // workflow's agent, landed in it, and had no way back — because the thing
    // he came from had never been an address either. Now both are.
    commitUrl(
      // No tab: an import OPENS in the chat, and the address says so by leaving
      // the segment off. A tab flip afterwards writes it.
      storePath === undefined ? { kind: "live", tab: null } : { kind: "import", path: storePath, tab: null },
      cause,
    );
    // The dialog is gone by the time this bar matters, so it belongs to the
    // session, not to the dialog. The VS Code note keeps its own sentence: that
    // export records that each tool ran and whether it succeeded, never what it
    // returned, and without saying so the empty tool bodies read as a broken
    // import.
    setImportBar({
      sessionId: `import:${kind}:${label}`,
      file: label,
      stats: sourceStats(source),
      // Two different sentences, and a file can want both: the VS Code note is
      // about a FORMAT's limits, the subagent note is about what THIS file is.
      // Only one of them can ever apply at a time today, and joining them here
      // keeps that an accident of the formats rather than a rule the bar
      // depends on.
      note:
        [kind === "vscode-agent" ? t(lang, "imp.vscodeNote") : null, subagentNote(lang, subagent)]
          .filter((line): line is string => line !== null)
          .join(" ") || null,
    });
  };

  // Scenario playback: compile the bilingual DSL in the current chrome
  // language and ride the SAME replay path. Lands in the Lab, where the
  // stepper starts at event 0 — a scripted demo is for stepping, not for
  // reading its end state. Compiled content keeps its language afterwards,
  // like every other session.
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [startersOpen, setStartersOpen] = useState(false);
  const openScenario = (dsl: Dsl): void => {
    const events = compile(dsl, lang);
    setScenariosOpen(false);
    if (dsl.fleet === true) {
      // A fleet scenario: fold the compiled events into a replay fleet and enter
      // it like a live one — the fleet canvas shows the topology at a glance.
      const contextId = `scenario:${dsl.id}`;
      fleetLoadScenario(contextId, events);
      enterFleet(contextId);
      return;
    }
    navNonce.issue(); // a scenario supersedes any in-flight session open
    setReplay({
      id: `scenario:${dsl.id}`,
      state: foldArchive(events),
      events,
    });
    // Loading a CHAT scenario must LEAVE an entered fleet — otherwise the
    // header shows the scenario while every tab (the lab included) still
    // renders the fleet's events. Owner-found: dialog-load after a fleet.
    setEnteredFleet(null);
    setTab("lab");
    // A scenario is a view, not an address (its id must never reach the bar).
    commitUrl({ kind: "live", tab: null }, "gesture");
  };

  const newChat = (): void => {
    // One socket connection = one session on the server, so a fresh chat
    // means a fresh connection.
    setLive(initialState);
    setLiveEvents([]); // the graph starts empty too
    setReplay(null);
    setEnteredFleet(null);
    setResumeId(null); // a fresh chat never carries an old session along
    setImagesOpen(false); // the gallery re-opens with the first new image
    // No provider state to reset: the fresh connection announces its backend
    // itself (provider_info frame) and the chip follows that.
    labResetLive(); // the Lab's dam starts empty too
    setTab("chat"); // a fresh chat STARTS in the chat — leaving a fleet's lab/graph behind
    setConnNonce((n) => n + 1);
    navNonce.issue(); // a fresh chat supersedes any in-flight session open
    commitUrl({ kind: "live", tab: null }, "gesture");
  };

  // Resume a stored session AS the live session: seed the UI from its JSONL
  // (chat, graph, trace and Lab show the full history), then reconnect the
  // socket with ?resume=<id> so the SERVER reloads the same history into the
  // agent and appends new events to the same file. The didactic payoff: the
  // next prompt re-uploads the whole history as messages[] — watch the
  // session_resume trace marker, then the context_info/usage jump.
  const resumeSession = async (id: string): Promise<void> => {
    if (live.running) return; // never hijack a running live session
    const ticket = navNonce.issue();
    try {
      // Same rule as openSession: the recorded exchanges are socket-only, so
      // the seeded history has none — the index restores them, and the new
      // socket's own llm_exchange frames simply append behind (fresh xids).
      const [res, wire] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(id)}/events`),
        fetchLlmWireIndex(id),
      ]);
      if (!res.ok) return;
      const events = (await res.json()) as RunEvent[];
      if (!navNonce.isCurrent(ticket)) return; // a later navigation already won
      const folded = foldArchive(events);
      const seeded = recordResumeMarker(
        wire.length === 0 ? folded : { ...folded, trace: mergeLlmExchanges(folded.trace, wire) },
        // history carries the full re-uploaded JSONL: the trace detail's
        // Raw/Compact views show it line by line, exactly as it rides along.
        { sessionId: id, ...summarizeHistory(events), history: events },
      );
      setLive(seeded);
      setLiveEvents(events);
      setReplay(null);
      setImagesOpen(false);
      labBackToLive(events); // the Lab dam holds the history; new events queue behind it
      setResumeId(id); // reconnects the socket with ?resume=<id>
      setConnNonce((n) => n + 1); // force a fresh connection even for the same id
      setTab("chat");
      commitUrl({ kind: "live", tab: null }, "gesture"); // resumed = the live view again
    } catch {
      // server unreachable: stay in the replay view, nothing lost
    }
  };

  // Only real stored sessions can be resumed (scenarios and imports have no
  // JSONL on this server to append to).
  const canResume = replay !== null && !replay.id.startsWith("scenario:") && !replay.id.startsWith("import:");

  // Delete the selected stored session for good (JSONL + blobs). The button
  // itself carries the two-step confirm; here only the irreversible call.
  // The session the live socket is RESUMING stays deletable-proof: the server
  // would happily append to a recreated file, so the UI does not offer it.
  const deleteSession = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) return; // 404/400: nothing deleted, stay in the view
      setReplay(null); // back to the live view
      setRefreshToken((n) => n + 1); // the sidebar list drops the entry
      // The address named a session that no longer exists: correct the bar
      // without minting an entry — a deletion is a fallback, not a navigation.
      commitUrl({ kind: "live", tab: null }, "apply");
    } catch {
      // server unreachable: nothing deleted, stay in the replay view
    }
  };
  const canDelete = canResume && replay !== null && replay.id !== resumeId;

  // Deep links: the whole address book (card 131) — #/{tab}, #/session/{id}
  // [@{n}][/{tab}], #/fleet/{contextId}, #/settings[/{section}], grown around
  // the card-81 receipt links, which resolve byte-for-byte unchanged.
  //
  // applyRoute executes the pure plan through the SAME state cores the sidebar
  // and tabs use — never by poking replay/enteredFleet ad hoc, or the
  // enteredFleet bleed would return through the back button. A fleet address
  // in a fresh tab hydrates the roster first, so it is judged against the hub,
  // not against an empty boot store; a route a guard refuses (locked fleets,
  // unknown fleet, unparseable address) falls through to the live default and
  // the bar is corrected by replace, never push.
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  const applyRoute = async (route: Route): Promise<void> => {
    if (route.kind === "fleet" && !fleetsLockedRef.current && !knownFleet(route.contextId)) {
      const key = formatRoute(route);
      await hydrateFleet();
      if (lastApplied.current !== key) return; // another navigation won meanwhile
    }
    const plan = planRoute(route, placeRef.current, {
      fleetsLocked: fleetsLockedRef.current,
      fleetKnown: route.kind !== "fleet" || knownFleet(route.contextId),
    });
    let opensSession = false;
    for (const action of plan.actions) {
      switch (action.kind) {
        case "open-session":
          opensSession = true;
          void openSessionRef.current(action.sessionId, action.eventIndex, {
            tab: action.tab,
            cause: "apply",
          });
          break;
        case "seek": {
          // Same session, new frame: the focus seam, never a refetch.
          const target = replayRef.current?.events[action.eventIndex];
          if (target) setFocusEvent(target);
          break;
        }
        case "set-tab":
          setTab(action.tab);
          break;
        case "open-import":
          // Following an address, so it REPLACES rather than pushes: the entry
          // is already in history, and pushing would make Back a no-op.
          openStoreTranscript(action.path, action.path.split("/").pop() ?? action.path, "apply");
          break;
        case "enter-fleet":
          applyFleet(action.contextId); // the beaconless core
          break;
        case "return-to-live":
          leaveToLiveCore();
          break;
        case "open-settings":
          setSettingsOpen(true);
          setSettingsSection(action.section);
          break;
        case "offer-view":
          // Left for the view to take once when it next notices. It cannot be
          // applied from here: the view owns the state, and the reading may
          // arrive before the view that reads it has mounted.
          offerIncomingView(action.tab, action.view);
          break;
        case "close-settings":
          setSettingsOpen(false);
          setSettingsSection(null);
          settingsPushed.current = false;
          break;
      }
    }
    // Normalization: the bar learns the canonical spelling, or the default a
    // refused address fell to — replace either way, follow never authors. An
    // open-session waits for its fetch (success needs no write, a dead
    // address is corrected in its catch).
    if (!opensSession) commitUrl(plan.effective, "apply");
  };
  const applyRouteRef = useRef(applyRoute);
  applyRouteRef.current = applyRoute;
  useEffect(() => {
    const follow = (event?: Event): void => {
      // A popstate carries the entry's own stamp; a hashchange does not, and
      // reading history.state is right for both.
      if (event?.type === "popstate") setDepth(navLanded(window.history.state));
      const route = parseAppRoute(window.location.hash);
      const key = formatRoute(route);
      // One back-press between hash entries fires hashchange AND popstate;
      // comparing the DISPATCHED route string — set synchronously, before any
      // async work — makes the second call a no-op. Comparing against app
      // state instead would lag the fetch and let both through. A new
      // SPELLING of the applied place ("#/bogus" typed over "#/") still gets
      // its bar corrected: writeRoute replaces on a raw difference and stays
      // silent on the echo, so this costs the double-fire nothing.
      if (key === lastApplied.current) {
        writeRoute(route, "apply");
        return;
      }
      lastApplied.current = key;
      void applyRouteRef.current(route);
    };
    follow();
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("popstate", follow);
    };
  }, []);

  const viewingLive = replay === null;

  // Showing a tab IS the observation for the view-only criteria. The session id
  // travels with it because two of them are joins: the ladder only counts a
  // trace you opened on a session that actually ran a tool, and a spectrum you
  // opened on a session that actually fanned out.
  const shownSessionId = viewingLive ? (live.workspace?.sessionId ?? null) : (replay?.id ?? null);
  const shownRef = useRef(shownSessionId);
  shownRef.current = shownSessionId;
  const openRef = useRef(true);
  openRef.current = leveling.snapshot ? isSurfaceOpen(leveling.snapshot, tab) : true;
  useEffect(() => {
    // Only a surface that actually RENDERED counts. Clicking a locked tab shows
    // its teaser, and a teaser is not the trace — reporting it would let a tab
    // unlock itself by being clicked, which is the whole ladder walked around.
    if (tab !== "chat" && openRef.current) beaconRef.current(tab, shownRef.current);
  }, [tab]);
  const recordedView = replay === null ? live : replay.state;
  // An import's trace rows learn which line of the file they came from. This
  // runs against the ORIGINAL stream and BEFORE the translation swap below:
  // swapTracePayloads spreads the row and replaces only its payload, so a field
  // on the row survives it. The other order attaches to payloads that are no
  // longer in the rows, and every frame silently loses its line.
  const sourcedView = useMemo(() => {
    if (replay === null || replay.source === undefined || enteredFleet !== null) return recordedView;
    return { ...recordedView, trace: attachSources(recordedView.trace, replay.events, replay.source.origin) };
  }, [recordedView, replay, enteredFleet]);

  // The tabs' flat event source, third-source duality: an entered fleet's events
  // win over the own live/replay session. The fold-tabs (spectrum/graph/text)
  // take a flat RunEvent[] and re-fold, so entering a fleet needs no tab change.
  const enteredFleetModel = useFleet(enteredFleet ?? undefined);
  // Memoized so the downstream fold-memos (trace, timeline) see a stable
  // reference — the ternary alone would re-derive on every render.
  const tabEvents = useMemo(
    () =>
      enteredFleet !== null ? enteredFleetModel.events : viewingLive ? liveEvents : (replay?.events ?? []),
    [enteredFleet, enteredFleetModel.events, viewingLive, liveEvents, replay],
  );
  // The translation is applied HERE, to the one array the tabs fold, because
  // every tab is a fold over it: translating the stream translates the chat,
  // the trace, the text feed, the graph, the spectrum and the lab at once.
  // `shownEvents` is `tabEvents` BY IDENTITY whenever nothing has been
  // translated or the reader asked for the original, so the untranslated app
  // recomputes exactly nothing. The recorded array itself is never touched —
  // it stays the thing the translate sheet plans and exports from.
  const viewKey = enteredFleet ?? replay?.id ?? "live";
  // Card 147: the trace's agent pin belongs to the view it was taken in. When
  // another session, a fleet, a scenario, an import, or a fresh/resumed chat
  // takes the screen, the pin does not ride along — it would filter the new
  // stream with the chip row hidden by the one-agent guard (measured: 2 of
  // 1575 rows visible, no message, no control). The identity carries the
  // connection nonce, so a new chat clears it even though the key stays "live".
  const pinIdentity = viewIdentity(connNonce, viewKey);
  const prevPinIdentity = useRef(pinIdentity);
  useEffect(() => {
    const previous = prevPinIdentity.current;
    prevPinIdentity.current = pinIdentity;
    setTraceAgent((pin) => pinAfterNavigation(previous, pinIdentity, pin));
  }, [pinIdentity]);
  // The selector is readonly by contract — it hands back the recorded array
  // itself when there is nothing to show. The tab props are not, and widening
  // once here beats five casts at the call sites; nothing downstream writes.
  const shownEvents = useTranslatedEvents(viewKey, tabEvents) as RunEvent[];
  const showingTranslation = shownEvents !== tabEvents;
  // The chat reads a FOLDED state, so a translated stream has to be folded
  // again — the same reducer, the same events, different text. Two things are
  // deliberately not taken from that second fold: the trace keeps its recorded
  // rows (with only the payloads swapped) so the frames this app SENT survive,
  // and everything App itself steers by — running, pending gates, the live
  // socket's provider — keeps reading `live`. A fleet is excluded because its
  // events are not this view's session at all.
  const view = useMemo(() => {
    if (!showingTranslation || enteredFleet !== null) return sourcedView;
    const folded = reduceAll(initialState, shownEvents);
    return {
      ...(replay === null ? folded : normalizeReplay(folded)),
      trace: swapTracePayloads(sourcedView.trace, tabEvents, shownEvents),
    };
  }, [showingTranslation, enteredFleet, sourcedView, replay, shownEvents, tabEvents]);
  // The lab is the one tab that does not fold on render: it STEPS a stream out
  // of a dam this app seeded. So it is handed the translated stream as the
  // stream it steps, which restarts its scrub. An archive re-seeds itself off
  // this new object; the live dam has no such prop and gets the effect below.
  // The session's pictures, in stream order, and which one the lightbox has
  // open. Derived from the folded view rather than kept as a second list: a
  // gallery with its own copy goes stale the moment a delta lands.
  // Each picture also carries WHICH LINE of the imported file brought it in, so
  // the lightbox's file face can show the record around it. The import already
  // holds both halves — the file's lines and `origin[i]` per event — so this is
  // a join, not a second read.
  const gallery = useMemo(() => {
    const shots = collectImages(view);
    const src = replay?.source;
    return src === undefined ? shots : withSourceLines(shots, imageLines(replay!.events, src.origin));
  }, [view, replay]);
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  // Any picture anywhere can ask to be opened; only this component owns the
  // lightbox, because it is the only one that can walk from a chat bubble to a
  // tool card three turns down.
  const imageRequest = useImageRequest();
  useEffect(() => {
    if (imageRequest.shot !== null) setLightboxAt(indexOf(gallery, imageRequest.shot));
    // `seq` and not the shot: clicking the SAME picture again after closing has
    // to reopen it, and a value-only dependency would see nothing change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageRequest.seq]);
  // A session change closes it — the picture that was open is not in this one.
  useEffect(() => setLightboxAt(null), [replay?.id, enteredFleet]);

  const labReplay = useMemo(
    () => (replay === null ? null : { id: replay.id, events: shownEvents }),
    [replay, shownEvents],
  );
  // chat-v2: the work fold, over the SHOWN stream, so the panel and the
  // transcript can never describe different sessions. Folded only while v2 is
  // the reading — v1 pays nothing for a prototype it does not render.
  const work = useMemo(() => (chatView === "v2" ? foldWork(shownEvents) : []), [chatView, shownEvents]);
  // The Spectrum / FleetCanvas hand-off, lifted to one place so the work panel
  // uses the SAME seam instead of a second one. Scope the trace to the event's
  // OWN agent so the focused row is never hidden by the filter.
  const focusInTrace = (agentId: string, event: RunEvent): void => {
    const evAgent =
      typeof (event as { agentId?: unknown }).agentId === "string"
        ? (event as { agentId: string }).agentId
        : agentId;
    setTraceAgent(evAgent);
    setFocusEvent(event);
    if (enteredFleet !== null) {
      setFleetTab("trace"); // variant B: the fleet bar owns the tab vocabulary
    } else {
      changeTab("trace"); // a gesture: the flip earns its address like a tab click
    }
  };
  // Choosing v2 opens the panel it is half of: a reading whose right column is
  // collapsed is v1 with the children missing. Only on the flip INTO v2 — a
  // reader who then closes the panel is not fought with.
  //
  // The effect said that and did not do it. Keyed on chatView alone, it also
  // ran on MOUNT, and v2 is the default reading, so every start reopened the
  // panel on Work — which a session with no run in it fills with "Nothing
  // yet.". The previous value is what tells a flip from a mount, and only a ref
  // carries it across renders. The layout store persists both the panel's open
  // state and its tab, so a start now lands where the reader left it.
  const lastChatView = useRef<ChatViewMode | null>(null);
  useEffect(() => {
    const previous = lastChatView.current;
    lastChatView.current = chatView;
    if (!isFlipIntoV2(previous, chatView)) return;
    openRightPanel();
    setActiveRightTab("work");
  }, [chatView]);
  const translation = useTranslation(viewKey);
  const labSeed = `${showingTranslation}:${translation.status}`;
  const seededRef = useRef(labSeed);
  const labStreamRef = useRef(shownEvents);
  labStreamRef.current = shownEvents;
  useEffect(() => {
    // Deliberately NOT keyed on the stream itself: that changes with every
    // streamed batch, and re-seeding per batch would throw the reader back to
    // event 0 while they step. A finished run and a flipped toggle are the two
    // moments the lab is actually looking at different text.
    if (!viewingLive || enteredFleet !== null || seededRef.current === labSeed) return;
    seededRef.current = labSeed;
    labBackToLive(labStreamRef.current);
  }, [labSeed, viewingLive, enteredFleet]);
  // The entered fleet's parked permission gates (block 4): the same GateBar,
  // but answered over REST to the node (POST /api/fleet/{node}/gate) instead of
  // the session socket. Best-effort like stop — if the node left, its own close
  // denies the gate, so a failed POST is nothing to shout about.
  const fleetGate = enteredFleet !== null ? fleetPending(enteredFleetModel) : [];
  const decideFleetGate = (callId: string, allowed: boolean): void => {
    const gate = fleetGate.find((g) => g.callId === callId);
    if (gate === undefined) return; // already decided, or the node is gone
    void fetch(`/api/fleet/${encodeURIComponent(gate.agentId)}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, allow: allowed }),
    }).catch(() => {
      // best-effort: the node's close denies the gate if this never lands
    });
  };
  // Stop a fleet node from the canvas — best-effort, confirmed once (the node
  // leaves the roster when it actually ends; re-click if a lost stop stranded it).
  const fleetHubPort = useFleetHubPort();
  // The lobby says how many fleets are already listed rather than implying none.
  const fleets = useFleets();
  // useCallback so the reference stays stable across App re-renders (a live
  // socket batch, say): otherwise it would re-key FleetCanvas's layout memo and
  // re-run dagre on every render while a fleet is open.
  const stopFleetNode = useCallback(
    (agentId: string): void => {
      const ok = window.confirm(
        lang === "de"
          ? `node "${agentId}" stoppen? (best-effort — bei verlorenem stop nochmal klicken)`
          : `stop node "${agentId}"? (best-effort — re-click if a stop is lost)`,
      );
      if (!ok) return;
      void fetch(`/api/fleet/${encodeURIComponent(agentId)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).catch(() => {
        // best-effort: SIGTERM (or a re-click) is the fallback for a lost stop
      });
    },
    [lang],
  );
  // The trace tab is a fold-tab too: an entered fleet's frames become inbound
  // trace entries (drill-in shows the MEMBER's wire, not the own session).
  // Exactly the chain's final else, hoisted so the trace can stay mounted while
  // another tab is showing. Kept next to the entries it renders, so the two
  // cannot drift apart.
  const traceMounted =
    // Both segment arms of the chain collapse into this one term under
    // `enteredFleet === null`: only the sessions segment reaches the tabs at
    // all, so the hidden trace must not survive a move to fleets or stategraph.
    nav === "sessions" &&
    enteredFleet === null &&
    tab === "trace" &&
    // The chain's leveling gate reads `tab !== "chat" && …`; under `tab ===
    // "trace"` that term is already true, and the compiler says so.
    !(leveling.snapshot && !isSurfaceOpen(leveling.snapshot, tab));

  const traceEntries = useMemo(
    () => (enteredFleet !== null ? traceFromEvents(shownEvents) : view.trace),
    [enteredFleet, shownEvents, view.trace],
  );

  // Where an expanded llm_exchange row may fetch its recorded bodies from: the
  // stored session on screen, or the live session once the server has named
  // one. Null for everything that has no sidecar to ask — an import, a
  // scenario, an entered fleet — and the detail then says so instead of
  // fetching a 404.
  const llmWireSessionId =
    enteredFleet !== null
      ? null
      : replay !== null
        ? canResume
          ? replay.id
          : null
        : (live.workspace?.sessionId ?? null);

  // Card 137: the trace's own address in the configured backend. Derived, not
  // fetched — the id is sha256 over the session id, the same seed OtlpSink
  // stamped on the spans. null whenever no link could work, which is most of
  // the time: nothing exported yet, the backend is not Langfuse, a fleet member's
  // wire is on screen, or the rows did not come off our own socket at all.
  const langfuseUrl = useMemo(
    () =>
      traceLinkFor({
        live: viewingLive,
        inFleet: enteredFleet !== null,
        sessionId: shownSessionId,
        endpoint: view.lastOtlpExport?.endpoint ?? null,
      }),
    [viewingLive, enteredFleet, shownSessionId, view.lastOtlpExport],
  );
  // The failure line only speaks while NOTHING has landed. Once an export has
  // succeeded the link stays, because the trace it wrote still exists.
  const otlpFailure =
    view.lastOtlpOutcome?.ok === false && view.lastOtlpExport === null
      ? (view.lastOtlpOutcome.message ?? "")
      : null;

  // The effective LLM backend for the header + the Lab map: the server's
  // provider_info frame is wire truth (sent on connect and after every
  // switch), then this view's run_start.provider, then the boot config.
  // Deliberately no optimistic layer — a refused switch sends no frame.
  const curProvider = live.providerInfo?.provider ?? view.provider ?? serverCfg?.provider ?? undefined;
  const curModel = live.providerInfo?.model ?? serverCfg?.model ?? undefined;

  // The per-session workspace picker: the SERVER opens the native folder
  // dialog (a browser cannot hand out absolute paths, spectroscope runs locally),
  // the picked path travels back over the socket. Only before the first run —
  // afterwards the sandbox and every subagent are anchored (server-enforced,
  // the button just mirrors it). This pin is THIS session only; a permanent
  // default for every future session lives in the Settings page's own
  // workspace field (a user-scope setting the server resolves per connection).
  const canPickWorkspace = viewingLive && !live.running && live.turns.length === 0;
  const pickWorkspace = async (): Promise<void> => {
    try {
      const res = await fetch("/api/pick-workspace", { method: "POST" });
      if (res.status !== 200) return; // 204 cancel, 409 busy, 501 no dialog
      const body = (await res.json()) as { path?: string };
      if (body.path) sendClient({ type: "set_workspace", path: body.path });
    } catch {
      // server unreachable — the connection banner already says so
    }
  };

  // The workspace announcement makes the Files panel visible: the first
  // workspace_info of a session opens the right panel on the Files tab —
  // the agent's desk appears where its files land.
  // Only a RESOLVED workspace throws the panel open. The connect-time frame
  // names a prospective folder for every new chat; opening the Files tab on it
  // would hijack the panel before anything has happened.
  const wsPath = live.workspace?.resolved === true ? (live.workspace.path ?? null) : null;
  useEffect(() => {
    if (wsPath !== null) {
      openRightPanel();
      setActiveRightTab("files");
    }
  }, [wsPath]);

  // The gallery opens for an image that ARRIVES while you are watching, never
  // for one a view already had. The old rule keyed on "are there any images",
  // so opening any archived session that happened to contain one threw the
  // panel open unasked, on every load (owner 2026-07-28). A count and a
  // previous count tell those two apart; a boolean cannot.
  const imageCount = view.images.length;
  const seenImages = useRef<number | null>(null);
  useEffect(() => {
    const before = seenImages.current;
    seenImages.current = imageCount;
    // null means this view was just mounted or switched: whatever it holds, it
    // held before we looked, so it is not an arrival.
    if (before !== null && imageCount > before) setImagesOpen(true);
  }, [imageCount]);
  // A view change resets the baseline, so the next count is a starting point
  // rather than a jump from the previous session's total.
  useEffect(() => {
    seenImages.current = null;
  }, [viewKey]);

  // While the Lab tab is active it owns the permission flow (the dialog
  // appears when the user STEPS onto the request) — suppress the global
  // gate bar meanwhile. Replays never ask.
  const gateVisible =
    enteredFleet === null && viewingLive && tab !== "lab" && live.pendingPermissions.length > 0;

  const firstUser = view.turns.find((turn) => turn.kind === "user");
  const title =
    firstUser !== undefined && firstUser.kind === "user"
      ? firstUser.text
      : viewingLive
        ? t(lang, "hdr.newSession")
        : t(lang, "hdr.archivedSession");

  return (
    <div
      className={`layout${sidebarOpen ? "" : " sidebar-closed"}`}
      style={{ "--sidebar-w": `${layout.sidebarW}px` } as CSSProperties}
    >
      <ParticleField design={designPrefs.design} enabled={designPrefs.particles} />
      {/* At the app level rather than inside the chat: the gallery walks from a
          bubble to a tool card three turns down, and a modal that lives in one
          of them cannot be walked out of. */}
      <ImageLightbox
        images={gallery}
        at={lightboxAt}
        onClose={() => setLightboxAt(null)}
        onGo={setLightboxAt}
        storePath={shownStorePath}
        sourceLines={replay?.source?.lines ?? null}
      />
      {sidebarOpen && (
        <Sidebar
          nav={nav}
          onNav={setNav}
          onCollapse={() => setSidebarOpen(false)}
          fleetsLocked={leveling.snapshot ? !isSurfaceOpen(leveling.snapshot, "fleets") : false}
          activeId={replay === null ? null : replay.id}
          refreshToken={refreshToken}
          onSelectLive={returnToLive}
          onSelectSession={(id) => void openSession(id)}
          onNewChat={newChat}
          onImport={() => setImportOpen(true)}
          onScenarios={() => setScenariosOpen(true)}
          onStarters={() => setStartersOpen(true)}
          onSelectScenario={openScenario}
          activeFleet={enteredFleet}
          onRemoveFleet={(contextId) => {
            removeFleet(contextId);
            if (enteredFleet === contextId) {
              // Leave a deleted fleet, and correct the bar without minting an
              // entry — a removal is a fallback, not a navigation.
              leaveToLiveCore();
              commitUrl({ kind: "live", tab: null }, "apply");
            }
          }}
          onSelectFleet={enterFleet}
          onSpawnNode={() => setSpawnDialogOpen(true)}
        />
      )}
      {importOpen && <ImportDialog onLoad={openImport} onClose={() => setImportOpen(false)} />}
      {scenariosOpen && <ScenarioDialog onPick={openScenario} onClose={() => setScenariosOpen(false)} />}
      {startersOpen && <StarterDialog onClose={() => setStartersOpen(false)} />}

      <div className="main-col">
        {sidebarOpen && (
          <Resizer
            className="sidebar-resizer"
            collapsed={false}
            chevron="left"
            label={t(lang, "nav.history")}
            onResize={(clientX) => setSidebarW(clientX)}
            onToggle={() => setSidebarOpen(false)}
          />
        )}
        <AppHeader
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          replayId={replay === null ? null : replay.id}
          resumed={resumeId !== null}
          title={title}
          imageCount={view.images.length}
          imagesOpen={imagesOpen}
          onToggleImages={() => setImagesOpen((o) => !o)}
          showPanelToggle={tab === "chat"}
          panelOpen={layout.rightPanelOpen}
          onTogglePanel={toggleRightPanel}
          settingsOpen={settingsOpen}
          onToggleSettings={() => (settingsOpen ? closeSettings() : openSettingsPage())}
          doctorOpen={doctorOpen}
          onToggleDoctor={() => setDoctorOpen((o) => !o)}
          onOpenKeymap={() => setKeymapOpen(true)}
          viewingLive={viewingLive}
          provider={curProvider}
          providerStatus={providerStatus ?? undefined}
          model={curModel}
          archiveProvider={view.provider ?? undefined}
          status={conn.status}
          onApplyProvider={changeProvider}
          lastInputTokens={view.lastInputTokens}
          context={view.context}
          running={live.running}
          onAbort={abort}
        />

        {conn.status !== "open" && (
          <ConnectionBanner
            status={conn.status}
            retryAt={conn.retryAt}
            onRetry={() => connRef.current?.reconnectNow()}
          />
        )}

        {/* Graph and trace are sibling renderers of the chat — the
            same event stream, three different lenses. */}
        {/* Brand voice: tab labels are lowercase wire vocabulary. */}
        {/* Variant B (0.7 A/B): an entered fleet swaps the whole nav for its
            own bar — [bus] [one tab per agent] [+]. */}
        {/* The stategraph arm sits FIRST and asks nothing about a fleet: it
            carries its own header, and a reader who left a fleet entered must
            not get that fleet's bar over a graph the fleet has no part in. */}
        {nav === "stategraph" ? null : nav === "fleets" && enteredFleet === null ? null : enteredFleet !==
          null ? (
          <FleetBar
            model={enteredFleetModel}
            active={fleetTab}
            onPick={(next) => {
              /* Picking an agent pins the trace filter with it — "trace per
                 agent" is one click away and already scoped (owner ask). */
              if (next.startsWith("agent:")) setTraceAgent(next.slice("agent:".length));
              setFleetTab(next);
            }}
            onSpawn={enteredFleet.startsWith("scenario:") ? undefined : () => setSpawnDialogOpen(true)}
          />
        ) : (
          <nav className="tab-nav" role="tablist" aria-label="View">
            {/* Back and forward, because the desktop shell has no URL bar and
                therefore no browser chrome to supply them. Dark when there is
                genuinely nothing there — the app stamps every entry it writes
                and counts, since the DOM reports no forward availability. */}
            <span className="tab-nav-history">
              <button
                type="button"
                className="tab-nav-step"
                disabled={!canGoBack(depth)}
                onClick={() => window.history.back()}
                title={t(lang, "nav.back")}
                aria-label={t(lang, "nav.back")}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10 3.5 5.5 8l4.5 4.5" />
                </svg>
              </button>
              <button
                type="button"
                className="tab-nav-step"
                disabled={!canGoForward(depth)}
                onClick={() => window.history.forward()}
                title={t(lang, "nav.forward")}
                aria-label={t(lang, "nav.forward")}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
              </button>
            </span>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              className={tab === "chat" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("chat")}
            >
              chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "spectrum"}
              className={tab === "spectrum" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("spectrum")}
            >
              spectrum
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "trace"}
              className={tab === "trace" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("trace")}
            >
              trace
              {view.trace.length > 0 && (
                <span className="tab-count tabular" aria-label={`${view.trace.length} frames`}>
                  {view.trace.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "graph"}
              className={tab === "graph" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("graph")}
            >
              graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "text"}
              className={tab === "text" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("text")}
            >
              text
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "lab"}
              className={tab === "lab" ? "tab tab--active" : "tab"}
              onClick={() => changeTab("lab")}
            >
              lab
            </button>
            {/* The way back to the record, on EVERY lens, and the only always
              visible one: the copy that sat next to the translate trigger is
              gone (2026-08-03), the sheet's own copy needs the sheet open. A
              reader on the trace or the text feed must not have to leave the
              tab they are on to see what was actually recorded. Rendered only
              once something IS translated, since an always-present span would
              eat the auto margin the level pill sits on. Deleting this one
              leaves no toggle on screen, which is why the drift test counts
              it. */}
            {translation.byId.size > 0 && (
              <span className="tab-nav__translate">
                <TranslateToggle viewKey={viewKey} />
              </span>
            )}
            {leveling.snapshot && leveling.snapshot.mode !== "off" && (
              <span className="tab-nav__level">
                <LevelPill
                  snapshot={leveling.snapshot}
                  flareSlot={levelUp ? levelUp.level - 1 : -1}
                  onOpen={() => setLevelPanelOpen(true)}
                />
              </span>
            )}
          </nav>
        )}

        {/* Find-in-view. One mount for every tab: the box positions itself
            against this wrapper, and each view reports its own hits. */}
        <SearchBox />
        {/* Variant B: the entered fleet's surface answers to ITS bar, not to
            the app tabs — bus = the ESB reading, anything else = that agent's
            feed. The tab ternaries below never see an entered fleet. */}
        {/* The fleets segment with nothing entered: the lobby, not the last
            session left standing. This branch sits ABOVE the entered-fleet one
            because "which segment" outranks "which fleet" — the reader pressed
            fleets, so fleets is what answers. */}
        {/* The state graph is the whole surface while its segment is showing —
            it answers a question no session tab asks, so it takes the area
            outright rather than sitting inside one run's tab row. The run is
            handed IN because this arm unmounts on every segment change. */}
        {nav === "stategraph" ? (
          <StateGraphPane run={stateGraphRun} onRun={setStateGraphRun} />
        ) : nav === "fleets" && enteredFleet === null ? (
          <FleetLobby
            fleetCount={fleets.length}
            hubPort={fleetHubPort}
            onSelectScenario={openScenario}
            onSpawn={() => setSpawnDialogOpen(true)}
          />
        ) : enteredFleet !== null ? (
          fleetTab === "bus" ? (
            <FleetBus
              model={enteredFleetModel}
              events={shownEvents}
              contextId={enteredFleet.startsWith("scenario:") ? undefined : enteredFleet}
              hubPort={fleetHubPort}
              onStop={stopFleetNode}
              onOpenTrace={(agentId) => {
                setTraceAgent(agentId);
                setFleetTab("trace");
              }}
              onFocusAgent={(agentId) => {
                setTraceAgent(agentId);
                setFleetTab(`agent:${agentId}`);
              }}
            />
          ) : fleetTab === "spectrum" ? (
            /* Owner pick after the A/B: the fleet keeps its spectrum reading —
               same component, same props as the (now unreachable) app-tab twin. */
            <SpectrumView
              events={shownEvents}
              running={enteredFleetModel.roster.some((node) => node.connected)}
              onOpenTrace={(agentId) => {
                setTraceAgent(agentId);
                setFleetTab("trace");
              }}
              onFocusEvent={focusInTrace}
              fleet={enteredFleetModel}
            />
          ) : fleetTab === "trace" ? (
            /* And the trace stays mandatory, agent-filterable via its own bar. */
            <TraceView
              entries={traceEntries}
              droppedRows={live.traceDropped}
              agentFilter={traceAgent}
              onAgentFilter={setTraceAgent}
              focusEvent={focusEvent}
              onFocusHandled={() => setFocusEvent(null)}
              langfuseUrl={langfuseUrl}
              otlpFailure={otlpFailure}
              sourceLines={null}
              provenance={traceProvenance(replay?.id ?? null, enteredFleet)}
              translated={false}
            />
          ) : (
            <AgentFeed
              agentId={fleetTab.slice("agent:".length)}
              events={shownEvents}
              card={enteredFleetModel.roster.find((node) => node.id === fleetTab.slice("agent:".length))}
            />
          )
        ) : tab !== "chat" && leveling.snapshot && !isSurfaceOpen(leveling.snapshot, tab) ? (
          /* A locked surface shows a teaser, never its content. The tab itself
             stays visible and clickable: a feature nobody can see is a feature
             nobody adopts. Chat is excluded by name because it opens at level 0,
             and the gate bar below sits OUTSIDE this chain by construction, so
             no lock can ever cover a permission request. */
          <LockedSurface
            snapshot={leveling.snapshot}
            surface={tab}
            onOpenEverything={() => void leveling.setMode("checklist")}
          />
        ) : tab === "chat" ? (
          enteredFleet !== null ? (
            /* A fleet has no chat — show its home (getting-started + spawn), not
               the stale session chat, so entering a fleet switches the pane. */
            <FleetHome
              contextId={enteredFleet}
              nodeCount={enteredFleetModel.roster.length}
              hubPort={fleetHubPort}
              onSpawn={() => setSpawnDialogOpen(true)}
            />
          ) : (
            /* Chat + gallery share the tab area; the graph tab is untouched.
             The right panel (agents + system context) docks on the far right. */
            <div
              className="chat-row"
              data-reveal
              ref={chatRowRef}
              style={{ "--right-panel-w": `${layout.rightPanelW}px` } as CSSProperties}
            >
              {(() => {
                // chat-v2 (PROTOTYPE): the two readings take the SAME props.
                // v1 is the default and is passed nothing extra, so it renders
                // exactly what it always rendered.
                const chatProps = {
                  state: view,
                  events: tabEvents,
                  sessionLabel: shownSessionId,
                  storePath: shownStorePath,
                  viewKey,
                  liveView: viewingLive,
                  onSend: send,
                  onReturnToLive: returnToLive,
                  onResume: canResume ? () => void resumeSession(replay!.id) : undefined,
                  onDelete: canDelete ? () => void deleteSession(replay!.id) : undefined,
                  exportId: canResume ? replay!.id : undefined,
                  // The sidecar link, only when the index answered non-empty
                  // for THIS session — an honest download offers no empty file.
                  llmWireId:
                    canResume && llmWire !== null && llmWire.sessionId === replay!.id && llmWire.count > 0
                      ? replay!.id
                      : undefined,
                  sendClient,
                  onPickFolder: pickWorkspace,
                  queued: queue,
                  onUnqueue: unqueue,
                  onAbort: abort,
                  stopRequested,
                };
                return chatView === "v2" ? (
                  <ChatV2
                    {...chatProps}
                    work={work}
                    onOpenWork={(id) => {
                      setWorkHighlight(id);
                      openRightPanel();
                      setActiveRightTab("work");
                    }}
                  />
                ) : (
                  <Chat {...chatProps} />
                );
              })()}
              {imagesOpen && (
                <>
                  <Resizer
                    collapsed={false}
                    chevron="right"
                    label={t(lang, "img.title")}
                    onResize={resizeImages}
                    onToggle={() => setImagesOpen(false)}
                  />
                  <ImagePanel
                    images={view.images}
                    provider={imageProvider}
                    keys={imageKeys}
                    width={layout.imagesW}
                    onProviderChange={changeImageProvider}
                    onClose={() => setImagesOpen(false)}
                    sessionId={viewingLive ? live.workspace?.sessionId : undefined}
                  />
                </>
              )}
              {layout.rightPanelOpen && (
                <>
                  <Resizer
                    collapsed={false}
                    chevron="right"
                    label="Panel"
                    onResize={resizeRightPanel}
                    onToggle={toggleRightPanel}
                  />
                  <RightPanel
                    agents={view.agents}
                    plan={view.plan}
                    activeTab={layout.activeRightTab}
                    onTab={setActiveRightTab}
                    onClose={toggleRightPanel}
                    provider={curProvider}
                    model={curModel}
                    thinking={thinking}
                    workspace={view.workspace}
                    onPickFolder={viewingLive ? pickWorkspace : undefined}
                    canPickFolder={canPickWorkspace}
                    fsRefreshSignal={viewingLive ? fsTick : undefined}
                    work={chatView === "v2" ? work : undefined}
                    sidecars={sidecars}
                    onOpenAgent={openSidecarAgent}
                    workHighlight={workHighlight}
                    onFocusEvent={focusInTrace}
                    liveView={viewingLive}
                  />
                </>
              )}
            </div>
          )
        ) : tab === "spectrum" ? (
          <SpectrumView
            events={shownEvents}
            running={
              enteredFleet !== null
                ? enteredFleetModel.roster.some((node) => node.connected)
                : viewingLive && live.running
            }
            onOpenTrace={(agentId) => {
              setTraceAgent(agentId);
              changeTab("trace");
            }}
            /* The seam is one function now (focusInTrace, above): an
               agent_spawn tick sits on the parent lane but carries the child's
               agentId, and events without an agentId stay visible under any
               filter, so the lane is a safe fallback there. */
            onFocusEvent={focusInTrace}
            /* In a fleet the lanes are hub nodes, so the view can name them:
               the roster carries each node's capabilities and its epoch. A
               plain session has no roster and passes nothing. */
            fleet={enteredFleet !== null ? enteredFleetModel : undefined}
          />
        ) : tab === "graph" ? (
          /* Variant B: an entered fleet never reaches this chain — the ESB
             reading lives on the fleet bar's own "bus" tab above. */
          <GraphView events={shownEvents} isReplay={!viewingLive} />
        ) : tab === "text" ? (
          <TextView
            events={shownEvents}
            label={shownSessionId}
            // The tab is handed the SHOWN stream and holds no second copy, so
            // its export sheet may read this view's translation — the
            // provenance line, the language tag on the jsonl — only while that
            // stream IS the translation. See textExportClaim.ts.
            viewKey={textExportViewKey({ viewKey, showingTranslation })}
            // Explain spends the server's BASE-config provider (that is what the
            // endpoint builds, not a live-switched session provider) — offer it
            // unless that provider explicitly reports needs-key; unknown maps
            // stay open and the endpoint's readable 503 covers the rest.
            explainReady={!serverCfg || !providerStatus || providerStatus[serverCfg.provider] !== "needs-key"}
          />
        ) : tab === "lab" ? (
          enteredFleet !== null ? (
            /* The fleet machine room (card 59): the entered fleet as ONE
               composed agent-system diagram — every node its own loop on the
               shared OS/LLM rails, with its own scrub/live transport. */
            <FleetLab
              model={enteredFleetModel}
              running={enteredFleetModel.roster.some((node) => node.connected)}
            />
          ) : (
            <LabView
              replay={labReplay}
              liveEvents={viewingLive ? shownEvents : liveEvents}
              running={live.running}
              provider={viewingLive ? curProvider : (view.provider ?? undefined)}
              model={viewingLive ? curModel : undefined}
              onSend={send}
              onDecide={decide}
              onReturnToLive={returnToLive}
              onResume={canResume ? () => void resumeSession(replay!.id) : undefined}
              onDelete={canDelete ? () => void deleteSession(replay!.id) : undefined}
              sendClient={sendClient}
            />
          )
        ) : null}
        {/* The trace is MOUNTED ONCE and hidden, never unmounted (card 175).
            Measured on a 9,319-row session: pressing the tab cost 955 ms of
            blocked main thread, because every one of those rows had left the
            DOM on the way out and had to be built again — 0 rows while the chat
            was showing. Hiding costs the memory of a page that already existed;
            unmounting costs a second of the reader's time, every press.

            `display: contents` rather than a wrapper with its own box, so the
            layout is byte-for-byte what it was when TraceView sat in the chain
            directly. The condition below IS the chain's final else, written out:
            not the fleet lobby, not inside a fleet, the leveling gate open, and
            no other tab claiming the surface.

            ⚠️ This only became safe once `withResponseRows` stopped rebuilding
            every row object (card 184's identity fix). Before that, a hidden
            mounted trace re-rendered all 9,320 rows on every frame batch of a
            live run, which would have broken the owner's own condition that the
            chat be provably no slower. */}
        <div style={{ display: traceMounted ? "contents" : "none" }}>
          <TraceView
            entries={traceEntries}
            droppedRows={live.traceDropped}
            agentFilter={traceAgent}
            onAgentFilter={setTraceAgent}
            focusEvent={focusEvent}
            onFocusHandled={() => setFocusEvent(null)}
            langfuseUrl={langfuseUrl}
            otlpFailure={otlpFailure}
            storePath={shownStorePath}
            sourceLines={enteredFleet === null ? (replay?.source?.lines ?? null) : null}
            /* An entered fleet's rows are not the replay's rows, so its file is
               taken away above. The sentence the pane then says is not "there
               is no file" three times over: this is which of the three. */
            provenance={traceProvenance(replay?.id ?? null, enteredFleet)}
            /* The same condition the payload swap above runs under. With a
               translation applied the wire face renders the rebuilt record, so
               the source pane's "byte for byte" sentence would be describing a
               line nobody stored. */
            translated={showingTranslation && enteredFleet === null}
            llmWireSessionId={llmWireSessionId}
          />
        </div>
        {leveling.snapshot && !leveling.snapshot.introSeen && (
          /* Asked once per home, and only for a home that has never been used —
             an existing operator is grandfathered into checklist by the server
             and never meets this screen. */
          <LevelingIntro onChoose={(mode) => void leveling.setMode(mode)} />
        )}
        {levelPanelOpen && leveling.snapshot && (
          <div className="lvl-drawer-scrim" onClick={() => setLevelPanelOpen(false)}>
            <div
              className="lvl-drawer"
              role="dialog"
              aria-label={t(lang, "leveling.panel.title")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="lvl-drawer__head">
                <span>{t(lang, "leveling.panel.title")}</span>
                <button type="button" className="lvl-drawer__close" onClick={() => setLevelPanelOpen(false)}>
                  ×
                </button>
              </div>
              <LevelingPanel
                snapshot={leveling.snapshot}
                onTick={(criterion) => void leveling.tick(criterion)}
                onOpenEverything={() => void leveling.setMode("checklist")}
              />
            </div>
          </div>
        )}
        {levelUp && leveling.snapshot && (
          <div className="lvl-toast" role="status">
            {t(lang, "leveling.levelUp.title", {
              name: translated(
                (k) => t(lang, k),
                leveling.snapshot.ladder.levels[levelUp.level]?.nameKey ?? "",
                levelName(leveling.snapshot.levelId),
              ),
            })}
            {levelUp.opened.length > 0 && (
              <div className="lvl-toast__opened">
                {t(lang, "leveling.levelUp.opened", { surfaces: levelUp.opened.join(" · ") })}
              </div>
            )}
          </div>
        )}
        {/* The gate surface: pending permissions as a first-class bar, on
            every lens — the violet line means "the run waits on you". */}
        {gateVisible && (
          <GateBar
            pending={live.pendingPermissions}
            cards={live.cards}
            workspaceConfigured={live.workspace?.configured ?? false}
            onDecide={decide}
          />
        )}
        {/* The FLEET gate: a node in ask mode parked a tool; answer it over the
            hub. Same bar, no "remember" (a remote node has no allowlist here).
            Shown on EVERY tab while a fleet is entered — since card 59 the lab
            tab renders the fleet's machine room, so the old own-session guard
            fell. */}
        {enteredFleet !== null && fleetGate.length > 0 && (
          <GateBar
            pending={fleetGate}
            cards={{}}
            workspaceConfigured={false}
            allowRemember={false}
            onDecide={decideFleetGate}
          />
        )}
        <UsageFooter state={view} connection={conn.status} />
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        section={settingsSection}
        providerStatus={providerStatus ?? undefined}
        onKeySaved={() => setConfigNonce((n) => n + 1)}
        leveling={leveling}
        onShowLocalNotice={() => {
          // The deliberate way back (card 144): settings folds away so the
          // sheet is read where it normally appears, over the app.
          setSettingsOpen(false);
          setLocalNoticeOpen(true);
        }}
      />
      <Keymap open={keymapOpen} onClose={() => setKeymapOpen(false)} />
      {shownBar !== null && (
        <div className="import-note-bar" role="status">
          <span>
            {t(lang, "imp.bar", {
              file: shownBar.file,
              lines: shownBar.stats.lines,
              frames: shownBar.stats.frames,
              zero: shownBar.stats.zeroLines,
            })}
            {shownBar.note !== null && ` ${shownBar.note}`}
          </span>
          <button type="button" className="ghost" onClick={() => setImportBar(null)}>
            {t(lang, "common.close")}
          </button>
        </div>
      )}
      {localNoticeOpen && (
        <LocalModelNotice model={live.providerInfo?.model} onDismiss={dismissLocalNotice} />
      )}
      <Onboarding
        open={onboardingOpen}
        onClose={() => {
          setOnboardingOpen(false);
          setOnboardingDismissed(true);
          try {
            localStorage.setItem(ONBOARDED_KEY, "1");
          } catch {
            /* storage may be blocked — readiness gating still hides it once configured */
          }
        }}
        onStartLocal={() => {
          // The zero-install path: the sheet's job is done (count it as seen),
          // and the chooser takes over.
          setOnboardingOpen(false);
          setOnboardingDismissed(true);
          try {
            localStorage.setItem(ONBOARDED_KEY, "1");
          } catch {
            /* ignore */
          }
          setLocalChooserOpen(true);
        }}
      />
      {localChooserOpen && (
        <LocalModelDialog
          onUse={(modelId) => {
            setLocalChooserOpen(false);
            changeProvider("spectro-local", modelId);
          }}
          onClose={() => setLocalChooserOpen(false)}
        />
      )}
      {spawnDialogOpen && (
        <div
          className="fleet-spawn-modal-backdrop"
          role="presentation"
          onClick={() => setSpawnDialogOpen(false)}
        >
          <div className="fleet-spawn-modal" onClick={(e) => e.stopPropagation()}>
            <FleetSpawnForm
              contextId={enteredFleet ?? ""}
              hubPort={fleetHubPort}
              onClose={() => setSpawnDialogOpen(false)}
            />
          </div>
        </div>
      )}
      <DoctorPanel
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        status={conn.status}
        providerInfo={live.providerInfo}
        permissionMode={view.permissionMode}
      />

      {/* Delta floods stay silent for screen readers; announce only turn ends. */}
      <div className="sr-only" aria-live="polite">
        {viewingLive && !live.running && live.turns.length > 0 ? "Response complete" : ""}
      </div>
    </div>
  );
}

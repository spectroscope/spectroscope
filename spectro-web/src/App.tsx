// The wiring: socket -> rAF batch -> reducer -> components. The live stream
// and a replayed archive are the same UiState shape from the same reducer;
// the app only decides which of the two the components render.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ClientMessage, RunEvent } from "./events";
import { connect } from "./transport/ws";
import type { Connection, ConnectionStatus } from "./transport/ws";
import { initialState, normalizeReplay, recordOutgoing, recordResumeMarker, reduceAll, traceFromEvents } from "./state/reducer";
import type { UiState } from "./state/reducer";
import { summarizeHistory } from "./state/resume";
import { AppHeader } from "./components/AppHeader";
import { Chat } from "./components/Chat";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ImagePanel } from "./components/ImagePanel";
import { ImportDialog } from "./components/ImportDialog";
import { GateBar } from "./components/GateBar";
import { DoctorPanel } from "./components/DoctorPanel";
import { Keymap } from "./components/Keymap";
import { Onboarding } from "./components/Onboarding";
import { ONBOARDED_KEY, shouldOnboard } from "./components/onboardingFlag";
import { ScenarioDialog } from "./components/ScenarioDialog";
import { compile } from "./scenario/compile";
import type { Dsl } from "./scenario/dsl";
import { Sidebar } from "./components/Sidebar";
import { Resizer } from "./components/Resizer";
import { RightPanel } from "./components/RightPanel";
import { fetchSettings, putSettings } from "./state/serverSettings";
import { openRightPanel, setActiveRightTab, setImagesW, setRightPanelW, setSidebarW, toggleRightPanel, useLayout } from "./state/layout";
import { TextView } from "./components/TextView";
import { TraceView } from "./components/TraceView";
import { UsageFooter } from "./components/UsageFooter";
import { GraphView } from "./graph/GraphView"; // the fifth consumer
import type { PendingAttachment } from "./components/AttachmentPreview";
import { SettingsPanel } from "./components/SettingsPanel";
import { ParticleField } from "./components/ParticleField";
import { LabView } from "./lab/LabView";
import { SpectrumView } from "./spectrum/SpectrumView";
import { FleetCanvas } from "./spectrum/FleetCanvas";
import { FleetSpawnForm } from "./spectrum/FleetSpawn";
import { backToLive as labBackToLive, pushLive as labPushLive, resetLive as labResetLive } from "./state/stepper";
import { fleetPushLive, hydrateFleet, useFleet, useFleetHubPort, fleetPending } from "./state/fleetStore";
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
  const [conn, setConn] = useState<ConnState>({ status: "connecting", retryAt: null });
  const [connNonce, setConnNonce] = useState(0); // bumped by "New chat" to force a fresh socket session
  const [resumeId, setResumeId] = useState<string | null>(null); // non-null: the socket continues this stored session
  const [refreshToken, setRefreshToken] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const layout = useLayout(); // persisted panel widths (sidebar + Lab panes)
  const [tab, setTab] = useState<"chat" | "spectrum" | "graph" | "trace" | "text" | "lab">("chat"); // spectrum = fleet lanes; trace = wire view; text = readable feed + raw JSONL; lab = step-through Flow map
  // Spectrum -> Trace hand-off: clicking a lane pins its agent as the trace's
  // agent filter (null = all agents). The chip row in the trace clears it.
  const [traceAgent, setTraceAgent] = useState<string | null>(null);
  // A Spectrum-band click hands one exact event to the Trace (open + flash it).
  const [focusEvent, setFocusEvent] = useState<RunEvent | null>(null);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]); // raw, for the graph
  // Provider/model, thinking and the image backend now live in the user's
  // server-side settings (~/.spectro/settings.json) — the server builds every
  // connection's agent straight from them. The useState seeds below are only
  // the harness's hardcoded BOOTSTRAP fallback until the settings-hydration
  // effect (below, near the /api/config fetch) pulls the real values once the
  // socket is open. A local flip still writes the user scope
  // (changeImageProvider/toggleThinking below), which shapes the default for
  // the NEXT session — and also latches controlsTouched so a later reconnect
  // never overwrites what the user just chose.
  const [imageProvider, setImageProvider] = useState("gemini");
  const [imagesOpen, setImagesOpen] = useState(false); // gallery panel
  const [thinking, setThinking] = useState(true); // reasoning visibility (on by default)
  const [settingsOpen, setSettingsOpen] = useState(false); // design drawer
  const [doctorOpen, setDoctorOpen] = useState(false); // calibration/status page
  const [keymapOpen, setKeymapOpen] = useState(false); // the ? shortcut sheet (edu port)
  const [spawnDialogOpen, setSpawnDialogOpen] = useState(false); // start a fleet node from the sidebar
  const [onboardingOpen, setOnboardingOpen] = useState(false); // first-run backend info sheet (once)
  // First run: no 'onboarded' flag yet → show the one-time backend picker so the
  // first screen is never "Opus selected and nothing works".
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(ONBOARDED_KEY);
    } catch {
      /* storage may be blocked (tests, private mode) — default to showing it */
    }
    if (shouldOnboard(stored)) setOnboardingOpen(true);
  }, []);
  // Global keymap shortcut: ? opens the sheet, Escape closes it. Guarded while
  // typing so it never eats a keystroke in the composer or a filter (edu port).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing =
        el !== null &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeymapOpen(true);
      } else if (e.key === "Escape") {
        setKeymapOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [serverCfg, setServerCfg] = useState<{ provider: string; model: string } | null>(null); // /api/config boot truth
  // Per-provider onboarding status from /api/config (ready | needs-key | local),
  // so the picker shows 'add a key to .env' instead of a fake list.
  const [providerStatus, setProviderStatus] = useState<Record<string, string> | null>(null);
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
    if (r) setRightPanelW(Math.max(RIGHT_PANEL_MIN_WIDTH_PX, Math.min(r.right - clientX, r.width - CHAT_RESERVED_MIN_WIDTH_PX)));
  };

  // The gallery resizes from its left edge too (owner 2026-07-20): width =
  // distance from the pointer to the panel's own right edge — the edge is
  // stable during the drag (whatever sits right of the gallery is fixed).
  const resizeImages = (clientX: number): void => {
    const panel = chatRowRef.current?.querySelector(".image-panel");
    const row = chatRowRef.current?.getBoundingClientRect();
    const r = panel?.getBoundingClientRect();
    if (r && row) setImagesW(Math.max(240, Math.min(r.right - clientX, row.width - CHAT_RESERVED_MIN_WIDTH_PX)));
  };

  // Design switcher: the live (draft) skin drives the particle backdrop and the
  // scroll-reveal hook. The skin itself is already on <html> via the store.
  const { prefs: designPrefs } = useDesignPrefs();
  useScrollReveal(designPrefs.scroll);
  const lang = useLang(); // UI-chrome language; chat content keeps its own

  // One setState per animation-frame batch: n events, one React render.
  // The same batch is kept raw — the graph tab is just another reducer.
  const onEvents = useCallback((batch: RunEvent[]) => {
    setLive((s) => reduceAll(s, batch));
    setLiveEvents((prev) => [...prev, ...batch]);
    labPushLive(batch); // the Lab's dam collects the same stream (no-op in replay)
    fleetPushLive(batch); // the fleet store splits out fleet_roster/fleet_event
  }, []);

  useEffect(() => {
    const connection = connect({
      onEvents,
      resume: resumeId ?? undefined, // ?resume=<id>: the server reloads the JSONL history
      onStatus: (status, retryDelayMs) =>
        setConn({
          status,
          retryAt:
            status === "closed" && retryDelayMs !== undefined
              ? Date.now() + retryDelayMs
              : null,
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

  // The ONE place client frames leave the app: every outgoing ClientMessage
  // is traced (dir "out") — but only when it actually hit the wire; send()
  // returns false while the socket is down and dropped frames never crossed.
  const sendClient = useCallback((msg: ClientMessage): boolean => {
    const sent = connRef.current?.send(msg) === true;
    if (sent) {
      setLive((s) => recordOutgoing(s, msg));
    }
    return sent;
  }, []);

  // the frame carries the bytes ({ mediaType, dataBase64 }); the
  // thumbnails are parked in the state and picked up by the run_start case —
  // the reducer builds the user bubble, so there is no local echo turn.
  const send = (text: string, attachments?: PendingAttachment[]): void => {
    const sent = sendClient({
      type: "user_message",
      text,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments: attachments.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) }
        : {}),
    });
    if (sent && attachments !== undefined && attachments.length > 0) {
      const parked = attachments.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 }));
      setLive((s) => ({ ...s, outboxAttachments: parked }));
    }
  };
  const abort = (): void => {
    sendClient({ type: "abort" });
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
    putSettings("user", { imageProvider: provider }).catch(() => {});
  };
  // Reasoning visibility: flips local state and tells the server (traced too).
  // Applies to the next run — the server keeps one agent per connection. The
  // user-settings write is fire-and-forget for the same reason as above.
  const toggleThinking = (): void => {
    controlsTouched.current = true; // ditto
    const next = !thinking;
    setThinking(next);
    sendClient({ type: "set_thinking", enabled: next });
    putSettings("user", { thinking: next }).catch(() => {});
  };
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

  // The active LLM backend (provider + model) for the header and the Lab map.
  // /api/config is the boot truth; a switch overrides it optimistically.
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (alive && c && typeof c.provider === "string") setServerCfg({ provider: c.provider, model: c.model ?? "" });
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
  }, []);

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

  // Replay: fetch the stored events and push them through the SAME reducer.
  const openSession = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`);
      if (!res.ok) throw new Error(String(res.status));
      const events = (await res.json()) as RunEvent[];
      setReplay({ id, state: foldArchive(events), events });
      setEnteredFleet(null);
    } catch {
      // Server unreachable or session gone — stay on the current view.
    }
  };

  const returnToLive = (): void => {
    setReplay(null);
    setEnteredFleet(null);
  };

  // Enter a fleet like a session: its events feed the tabs; land on Spectrum so
  // the agents are visible at once, and clear any single-agent trace filter.
  const enterFleet = (contextId: string): void => {
    setReplay(null);
    setEnteredFleet(contextId);
    setTraceAgent(null);
    setTab("spectrum");
  };

  // Session import (spectroscope JSONL or an adapted Claude Code transcript): the
  // loaded stream takes the SAME replay path as a stored session.
  const [importOpen, setImportOpen] = useState(false);
  const openImport = (events: RunEvent[], label: string, kind: "spectroscope" | "claude-code"): void => {
    setReplay({
      id: `import:${kind}:${label}`,
      state: foldArchive(events),
      events,
    });
    setImportOpen(false);
  };

  // Scenario playback: compile the bilingual DSL in the current chrome
  // language and ride the SAME replay path. Lands in the Lab, where the
  // stepper starts at event 0 — a scripted demo is for stepping, not for
  // reading its end state. Compiled content keeps its language afterwards,
  // like every other session.
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const openScenario = (dsl: Dsl): void => {
    const events = compile(dsl, lang);
    setReplay({
      id: `scenario:${dsl.id}`,
      state: foldArchive(events),
      events,
    });
    setScenariosOpen(false);
    setTab("lab");
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
    setConnNonce((n) => n + 1);
  };

  // Resume a stored session AS the live session: seed the UI from its JSONL
  // (chat, graph, trace and Lab show the full history), then reconnect the
  // socket with ?resume=<id> so the SERVER reloads the same history into the
  // agent and appends new events to the same file. The didactic payoff: the
  // next prompt re-uploads the whole history as messages[] — watch the
  // session_resume trace marker, then the context_info/usage jump.
  const resumeSession = async (id: string): Promise<void> => {
    if (live.running) return; // never hijack a running live session
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`);
      if (!res.ok) return;
      const events = (await res.json()) as RunEvent[];
      const seeded = recordResumeMarker(
        foldArchive(events),
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
    } catch {
      // server unreachable: stay in the replay view, nothing lost
    }
  };

  // Only real stored sessions can be resumed (scenarios and imports have no
  // JSONL on this server to append to).
  const canResume =
    replay !== null && !replay.id.startsWith("scenario:") && !replay.id.startsWith("import:");

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
    } catch {
      // server unreachable: nothing deleted, stay in the replay view
    }
  };
  const canDelete = canResume && replay !== null && replay.id !== resumeId;

  const viewingLive = replay === null;
  const view = replay === null ? live : replay.state;

  // The tabs' flat event source, third-source duality: an entered fleet's events
  // win over the own live/replay session. The fold-tabs (spectrum/graph/text)
  // take a flat RunEvent[] and re-fold, so entering a fleet needs no tab change.
  const enteredFleetModel = useFleet(enteredFleet ?? undefined);
  const tabEvents = enteredFleet !== null
    ? enteredFleetModel.events
    : (viewingLive ? liveEvents : (replay?.events ?? []));
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
  // useCallback so the reference stays stable across App re-renders (a live
  // socket batch, say): otherwise it would re-key FleetCanvas's layout memo and
  // re-run dagre on every render while a fleet is open.
  const stopFleetNode = useCallback((agentId: string): void => {
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
  }, [lang]);
  // The trace tab is a fold-tab too: an entered fleet's frames become inbound
  // trace entries (drill-in shows the MEMBER's wire, not the own session).
  const traceEntries = useMemo(
    () => (enteredFleet !== null ? traceFromEvents(tabEvents) : view.trace),
    [enteredFleet, tabEvents, view.trace],
  );

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
  const wsPath = live.workspace?.path ?? null;
  useEffect(() => {
    if (wsPath !== null) {
      openRightPanel();
      setActiveRightTab("files");
    }
  }, [wsPath]);

  // auto-open the gallery when the first image of a view arrives
  // (0 -> >0). Closing it afterwards sticks until the count drops to zero.
  const hasImages = view.images.length > 0;
  useEffect(() => {
    if (hasImages) setImagesOpen(true);
  }, [hasImages]);

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
      {sidebarOpen && (
        <Sidebar
          activeId={replay === null ? null : replay.id}
          refreshToken={refreshToken}
          onSelectLive={returnToLive}
          onSelectSession={(id) => void openSession(id)}
          onNewChat={newChat}
          onImport={() => setImportOpen(true)}
          onScenarios={() => setScenariosOpen(true)}
          activeFleet={enteredFleet}
          onSelectFleet={enterFleet}
          onSpawnNode={() => setSpawnDialogOpen(true)}
        />
      )}
      {importOpen && <ImportDialog onLoad={openImport} onClose={() => setImportOpen(false)} />}
      {scenariosOpen && <ScenarioDialog onPick={openScenario} onClose={() => setScenariosOpen(false)} />}

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
          thinking={thinking}
          onToggleThinking={toggleThinking}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((o) => !o)}
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
        <nav className="tab-nav" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={tab === "chat"}
            className={tab === "chat" ? "tab tab--active" : "tab"}
            onClick={() => setTab("chat")}>chat</button>
          <button type="button" role="tab" aria-selected={tab === "spectrum"}
            className={tab === "spectrum" ? "tab tab--active" : "tab"}
            onClick={() => setTab("spectrum")}>spectrum</button>
          <button type="button" role="tab" aria-selected={tab === "trace"}
            className={tab === "trace" ? "tab tab--active" : "tab"}
            onClick={() => setTab("trace")}>
            trace
            {view.trace.length > 0 && (
              <span className="tab-count tabular" aria-label={`${view.trace.length} frames`}>
                {view.trace.length}
              </span>
            )}
          </button>
          <button type="button" role="tab" aria-selected={tab === "graph"}
            className={tab === "graph" ? "tab tab--active" : "tab"}
            onClick={() => setTab("graph")}>graph</button>
          <button type="button" role="tab" aria-selected={tab === "text"}
            className={tab === "text" ? "tab tab--active" : "tab"}
            onClick={() => setTab("text")}>text</button>
          <button type="button" role="tab" aria-selected={tab === "lab"}
            className={tab === "lab" ? "tab tab--active" : "tab"}
            onClick={() => setTab("lab")}>lab</button>
        </nav>

        {tab === "chat" ? (
          /* Chat + gallery share the tab area; the graph tab is untouched.
             The right panel (agents + system context) docks on the far right. */
          <div
            className="chat-row"
            data-reveal
            ref={chatRowRef}
            style={{ "--right-panel-w": `${layout.rightPanelW}px` } as CSSProperties}
          >
            <Chat
              state={view}
              liveView={viewingLive}
              onSend={send}
              onReturnToLive={returnToLive}
              onResume={canResume ? () => void resumeSession(replay!.id) : undefined}
              onDelete={canDelete ? () => void deleteSession(replay!.id) : undefined}
              sendClient={sendClient}
            />
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
                />
              </>
            )}
          </div>
        ) : tab === "spectrum" ? (
          <SpectrumView
            events={tabEvents}
            running={enteredFleet !== null
              ? enteredFleetModel.roster.some((node) => node.connected)
              : viewingLive && live.running}
            onOpenTrace={(agentId) => {
              setTraceAgent(agentId);
              setTab("trace");
            }}
            onFocusEvent={(agentId, event) => {
              // Scope the trace to the event's OWN agent so the focused row is
              // never hidden by the filter: an agent_spawn tick sits on the
              // parent lane but carries the child's agentId; events without an
              // agentId (agent_message) stay visible under any filter, so the
              // lane is a safe fallback there.
              const evAgent =
                typeof (event as { agentId?: unknown }).agentId === "string"
                  ? (event as { agentId: string }).agentId
                  : agentId;
              setTraceAgent(evAgent);
              setFocusEvent(event);
              setTab("trace");
            }}
          />
        ) : tab === "graph" ? (
          enteredFleet !== null ? (
            <FleetCanvas
              model={enteredFleetModel}
              events={tabEvents}
              contextId={enteredFleet}
              hubPort={fleetHubPort}
              onStop={stopFleetNode}
              onOpenTrace={(agentId) => {
                setTraceAgent(agentId);
                setTab("trace");
              }}
            />
          ) : (
            <GraphView events={tabEvents} isReplay={!viewingLive} />
          )
        ) : tab === "text" ? (
          <TextView events={tabEvents} />
        ) : tab === "lab" ? (
          <LabView
            replay={replay}
            liveEvents={liveEvents}
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
        ) : (
          <TraceView
            entries={traceEntries}
            agentFilter={traceAgent}
            onAgentFilter={setTraceAgent}
            focusEvent={focusEvent}
            onFocusHandled={() => setFocusEvent(null)}
          />
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
            Suppressed on the lab tab, which shows own-session content, mirroring
            the session gate's tab guard above. */}
        {enteredFleet !== null && tab !== "lab" && fleetGate.length > 0 && (
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

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Keymap open={keymapOpen} onClose={() => setKeymapOpen(false)} />
      <Onboarding
        open={onboardingOpen}
        onClose={() => {
          setOnboardingOpen(false);
          try {
            localStorage.setItem(ONBOARDED_KEY, "1");
          } catch {
            /* storage may be blocked — the sheet just shows again next time */
          }
        }}
      />
      {spawnDialogOpen && (
        <div className="fleet-spawn-modal-backdrop" role="presentation" onClick={() => setSpawnDialogOpen(false)}>
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

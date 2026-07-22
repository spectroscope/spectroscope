// Session navigation. "New chat" is the sidebar's only primary action; the
// Live row returns to the current socket session; every stored session below
// it opens as a replay through the same reducer as the live stream.

import { useEffect, useState } from "react";
import type { SessionMeta } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatTokens, relativeTime } from "../format";
import { useFleets } from "../state/fleetStore";
import { FleetSigil } from "../spectrum/FleetSigil";

export function Sidebar(props: {
  /** null = the live socket session is shown. */
  activeId: string | null;
  /** Bump to refetch the list (e.g. after a run finished). */
  refreshToken: number;
  onSelectLive: () => void;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  /** Opens the session-import dialog (spectroscope JSONL or Claude Code transcript). */
  onImport: () => void;
  /** Opens the scenario picker (scripted demo runs) — its own surface. */
  onScenarios: () => void;
  /** The entered fleet's contextId, or null when a session is shown. */
  activeFleet: string | null;
  /** Enter a fleet — inspect its agents like a session. */
  onSelectFleet: (contextId: string) => void;
  /** Open the spawn dialog — start the FIRST node from the UI (the fleet-canvas
   *  spawn panel is unreachable until a fleet already exists). */
  onSpawnNode: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [nav, setNav] = useState<"sessions" | "fleets">("sessions");
  const lang = useLang();
  const fleets = useFleets();
  // Attention-first: a fleet with a pending gate floats to the top, then by
  // most recent activity — a manager sees who is blocked on them.
  const orderedFleets = [...fleets].sort(
    (a, b) => Number(b.pendingGate) - Number(a.pendingGate) || b.lastActivity - a.lastActivity,
  );

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error(String(res.status));
        const list = (await res.json()) as SessionMeta[];
        if (!alive) return;
        setSessions([...list].sort((a, b) => b.startedAt - a.startedAt));
        setFailed(false);
      } catch {
        if (!alive) return;
        setSessions((prev) => prev ?? []);
        setFailed(true);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [props.refreshToken]);

  return (
    <aside className="sidebar">
      <div className="brand">
        {/* The M1 line bundle (brand logo), inline so the bars read the active
            theme's spectral tokens — geometry from design/assets/svg/logo-icon.svg. */}
        <svg className="brand-mark" viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">
          <rect x="13.2" y="14" width="2.6" height="36" rx="0.7" fill="var(--sp-red)" />
          <rect x="21.7" y="14" width="1.6" height="36" rx="0.7" fill="var(--sp-amber)" />
          <rect x="28.9" y="14" width="5.2" height="36" rx="0.7" fill="var(--sp-teal)" />
          <rect x="42" y="14" width="2" height="36" rx="0.7" fill="var(--sp-ocean)" />
          <rect x="49.35" y="14" width="1.3" height="36" rx="0.7" fill="var(--text-faint)" />
        </svg>
        spectroscope
      </div>

      <button type="button" className="soft-primary new-chat" onClick={props.onNewChat}>
        {t(lang, "nav.newChat")}
      </button>

      {/* Scenarios get their OWN area (owner decision): scripted demo runs
          live on a dedicated surface, never mixed into the session list. */}
      <button
        type="button"
        className="ghost sidebar-scenarios"
        onClick={props.onScenarios}
        title={t(lang, "nav.scenariosTitle")}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
        </svg>
        {t(lang, "nav.scenarios")}
      </button>

      <div className="sidebar-eyebrow-row">
        <div className="sidebar-seg" role="tablist" aria-label={t(lang, "nav.navMode")}>
          <button
            type="button" role="tab" aria-selected={nav === "sessions"}
            className={`sidebar-seg-btn${nav === "sessions" ? " active" : ""}`}
            onClick={() => setNav("sessions")}
          >
            Sessions
          </button>
          <button
            type="button" role="tab" aria-selected={nav === "fleets"}
            className={`sidebar-seg-btn${nav === "fleets" ? " active" : ""}`}
            onClick={() => setNav("fleets")}
          >
            {t(lang, "nav.fleets")}
            {fleets.length > 0 && <span className="sidebar-seg-badge tabular">{fleets.length}</span>}
          </button>
        </div>
        {nav === "sessions" && (
          <button type="button" className="sidebar-import" onClick={props.onImport}
            title={t(lang, "nav.importTitle")}>
            Import
          </button>
        )}
        {nav === "fleets" && (
          <button type="button" className="sidebar-import sidebar-spawn" onClick={props.onSpawnNode}
            title={lang === "de" ? "einen node starten (read-only)" : "spawn a node (read-only)"}>
            + node
          </button>
        )}
      </div>

      {nav === "sessions" ? (
        <>
          <nav className="session-list" aria-label="Sessions">
            <button
              type="button"
              className={`session-row live-row${props.activeId === null && props.activeFleet === null ? " active" : ""}`}
              onClick={props.onSelectLive}
            >
              <span className="session-title">
                <span className="dot accent" aria-hidden="true" /> {t(lang, "nav.live")}
              </span>
              <span className="session-meta">{t(lang, "nav.liveSub")}</span>
            </button>

            {sessions?.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`session-row${props.activeId === s.id && props.activeFleet === null ? " active" : ""}`}
                title={`${s.firstPrompt !== "" ? s.firstPrompt : t(lang, "nav.emptySession")}\n${new Date(s.startedAt).toLocaleString(lang === "de" ? "de-DE" : "en-US")}`}
                onClick={() => props.onSelectSession(s.id)}
              >
                <span className="session-title">
                  {s.firstPrompt !== "" ? s.firstPrompt : t(lang, "nav.emptySession")}
                </span>
                <span className="session-meta tabular">
                  {relativeTime(s.startedAt, Date.now(), lang)} &middot; {formatTokens(s.tokens)} tokens
                </span>
              </button>
            ))}
          </nav>

          {sessions !== null && sessions.length === 0 && !failed && (
            <p className="sidebar-note">{t(lang, "nav.none")}</p>
          )}
          {failed && <p className="sidebar-note">{t(lang, "nav.unreachable")}</p>}
        </>
      ) : (
        <nav className="session-list fleet-list" aria-label={t(lang, "fleet.rosterAria")}>
          {orderedFleets.length === 0 ? (
            <div className="fleet-empty">
              <p className="sidebar-note">{t(lang, "nav.noFleets")}</p>
              <button type="button" className="fleet-empty-spawn" onClick={props.onSpawnNode}>
                + {lang === "de" ? "node starten" : "spawn a node"}
              </button>
            </div>
          ) : (
            orderedFleets.map((f) => (
              <button
                type="button"
                key={f.contextId}
                className={`session-row fleet-row${props.activeFleet === f.contextId ? " active" : ""}`}
                onClick={() => props.onSelectFleet(f.contextId)}
                title={f.contextId}
              >
                <span className="session-title fleet-row-title">
                  <FleetSigil roster={f.roster} />
                  <span className="fleet-row-name mono">{f.contextId}</span>
                  {f.pendingGate && (
                    <span className="fleet-gate-chip mono pulse">{t(lang, "sp.gateOpen")}</span>
                  )}
                </span>
                <span className="session-meta tabular">
                  {t(lang, "fleet.count", { n: f.agentCount, online: f.onlineCount })}
                  {f.lastActivity > 0 && ` · ${relativeTime(f.lastActivity, Date.now(), lang)}`}
                </span>
              </button>
            ))
          )}
        </nav>
      )}
    </aside>
  );
}

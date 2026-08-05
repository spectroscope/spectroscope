// Session navigation. "New chat" is the sidebar's only primary action; the
// Live row returns to the current socket session; every stored session below
// it opens as a replay through the same reducer as the live stream.

import { useEffect, useMemo, useState } from "react";
import type { SessionMeta } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatTokens, relativeTime } from "../format";
import {
  SessionSigil,
  countLabel,
  groupSessions,
  sessionModelLabel,
  sessionSignal,
  sessionTitleLines,
} from "./sessionRows";
import { useFleets } from "../state/fleetStore";
import { FleetSigil } from "../spectrum/FleetSigil";
import { SCENARIOS } from "../scenario/registry";
import { loc, type Dsl } from "../scenario/dsl";

export function Sidebar(props: {
  /** True while the fleets segment is still ahead on the ladder. The segment
   *  stays visible and dimmed rather than vanishing: a feature nobody can see
   *  is a feature nobody adopts. */
  fleetsLocked?: boolean;
  /** null = the live socket session is shown. */
  activeId: string | null;
  /** Bump to refetch the list (e.g. after a run finished). */
  refreshToken: number;
  onSelectLive: () => void;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  /** Opens the session-import dialog (spectroscope JSONL or Claude Code transcript). */
  onImport: () => void;
  /** Opens the scenario picker modal — kept alongside the inline scenario rows
   *  below (a redundant second path; the owner may retire the modal later). */
  onScenarios: () => void;
  onStarters: () => void;
  /** Play a scenario inline from the list — replays it like a session. */
  onSelectScenario: (dsl: Dsl) => void;
  /** The entered fleet's contextId, or null when a session is shown. */
  activeFleet: string | null;
  /** Enter a fleet — inspect its agents like a session. */
  onSelectFleet: (contextId: string) => void;
  /** Open the spawn dialog — start the FIRST node from the UI (the fleet-canvas
   *  spawn panel is unreachable until a fleet already exists). */
  onSpawnNode: () => void;
  /** Remove a DONE fleet from the list (only offered when 0 nodes online). */
  onRemoveFleet?: (contextId: string) => void;
  /** Which segment is showing. Lifted out of this component (card 179): while
   *  it was a private useState, pressing `fleets` re-rendered the sidebar's own
   *  list and NOTHING else — App was never told, so the whole right-hand side
   *  stood still until something was loaded. */
  nav: "sessions" | "fleets";
  /** Switch segment. App owns the state so the surface can answer the press. */
  onNav: (next: "sessions" | "fleets") => void;
  /** Fold the sidebar away. Offered here as well as in the header because the
   *  header's own control is the first thing a narrow window takes away. */
  onCollapse?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const nav = props.nav;
  /** Piles the reader has unfolded, by group key. Piles start folded: the
   *  reason a pile exists is that its rows do not repay the space. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
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

  // Folded once per fetch, not once per render: the list is refetched whenever
  // a run finishes and can hold hundreds of rows, and every unrelated re-render
  // of this sidebar (a fleet frame, a language flip) would otherwise redo it.
  const groups = useMemo(() => groupSessions(sessions ?? []), [sessions]);

  const toggleGroup = (key: string): void =>
    setUnfolded((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /** One stored session. Rows inside an unfolded pile are indented, nothing else. */
  const sessionRow = (s: SessionMeta, inPile: boolean) => (
    <button
      type="button"
      key={s.id}
      className={`session-row${inPile ? " piled-row" : ""}${props.activeId === s.id && props.activeFleet === null ? " active" : ""}`}
      title={sessionTitleLines(s, lang)}
      onClick={() => props.onSelectSession(s.id)}
    >
      <span className="session-title session-title-line">
        <SessionSigil signal={sessionSignal(s)} />
        <span className="session-name">
          {s.firstPrompt !== "" ? s.firstPrompt : t(lang, "nav.emptySession")}
        </span>
      </span>
      <span className="session-meta session-meta-line tabular">
        <span className="session-facts">
          {relativeTime(s.startedAt, Date.now(), lang)}
          {(s.turnCount ?? 0) > 0 && (
            <> &middot; {countLabel(lang, "turn", s.turnCount ?? 0)}</>
          )} &middot; {countLabel(lang, "token", s.tokens, formatTokens(s.tokens))}
        </span>
        {/* The model only earns a place once the rail is wide enough to spell
            it out — see the container query. Truncated to "claude-s…" it answers
            nothing, and it would be answering it with the token count's space. */}
        {sessionModelLabel(s) !== "" && <span className="session-model mono">{sessionModelLabel(s)}</span>}
      </span>
    </button>
  );

  return (
    <aside className="sidebar">
      {/* Everything down to the sessions/fleets switch is one sticky block.
          The collapse control had just moved onto the brand so a narrow window
          could still reach it — and then scrolling took the brand away with it,
          which is the same joke one turn later. A control you can lose by
          scrolling is a control that is only sometimes there. */}
      <div className="sidebar-head">
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
          {/* The collapse control lives HERE as well as in the header, and the
            reason is a small circular joke the owner named: the header's burger
            scrolls out of reach on a narrow window, so the one button that would
            give you room back is only reachable once you already have room. A
            control for hiding a thing belongs on the thing. */}
          {props.onCollapse !== undefined && (
            <button
              type="button"
              className="brand-collapse"
              onClick={props.onCollapse}
              title={t(lang, "hdr.sidebarHide")}
              aria-label={t(lang, "hdr.sidebarHide")}
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
              </svg>
            </button>
          )}
        </div>

        {/* One wrapper so the three actions carry their OWN gap; the sidebar's column
          gap still sets the distance to the wordmark above and the segmented
          control below, which stay where they were. */}
        <div className="sidebar-actions">
          <button type="button" className="soft-primary new-chat" onClick={props.onNewChat}>
            {t(lang, "nav.newChat")}
          </button>

          {/* Owner (2026-07-22) reversed the earlier "own area" call: scenarios are now
            ALSO listed inline in the session list below. This button + its modal are
            kept for now (a redundant second path — owner may retire them). */}
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

          <button
            type="button"
            className="ghost sidebar-scenarios"
            onClick={props.onStarters}
            title={t(lang, "nav.startersTitle")}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path
                d="M8 2v12M2 8h12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            {t(lang, "nav.starters")}
          </button>
        </div>

        <div className="sidebar-eyebrow-row">
          <div className="sidebar-seg" role="tablist" aria-label={t(lang, "nav.navMode")}>
            <button
              type="button"
              role="tab"
              aria-selected={nav === "sessions"}
              className={`sidebar-seg-btn${nav === "sessions" ? " active" : ""}`}
              onClick={() => props.onNav("sessions")}
            >
              Sessions
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={nav === "fleets"}
              className={`sidebar-seg-btn${nav === "fleets" ? " active" : ""}`}
              onClick={() => !props.fleetsLocked && props.onNav("fleets")}
              aria-disabled={props.fleetsLocked ? true : undefined}
            >
              {t(lang, "nav.fleets")}
              {fleets.length > 0 && <span className="sidebar-seg-badge tabular">{fleets.length}</span>}
            </button>
          </div>
          {nav === "sessions" && (
            <button
              type="button"
              className="sidebar-import"
              onClick={props.onImport}
              title={t(lang, "nav.importTitle")}
            >
              Import
            </button>
          )}
          {/* Only when fleets EXIST — the empty state below carries its own spawn
            button, so two "+ node" affordances never show at once (owner). */}
          {nav === "fleets" && orderedFleets.length > 0 && (
            <button
              type="button"
              className="sidebar-import sidebar-spawn"
              onClick={props.onSpawnNode}
              title={lang === "de" ? "einen node starten (read-only)" : "spawn a node (read-only)"}
            >
              + node
            </button>
          )}
        </div>
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

            {groups.map((group) => {
              if (group.sessions.length === 1) return sessionRow(group.sessions[0], false);
              // A pile the reader is standing in stays open whatever the fold
              // says: collapsing the row you just opened loses your place.
              const holdsActive =
                props.activeFleet === null && group.sessions.some((s) => s.id === props.activeId);
              const open = unfolded.has(group.key) || holdsActive;
              const head = group.sessions[0];
              const total = group.sessions.reduce((sum, s) => sum + s.tokens, 0);
              return (
                <div className="session-pile" key={group.key}>
                  <button
                    type="button"
                    className={`session-row pile-row${open ? " open" : ""}`}
                    aria-expanded={open}
                    title={t(lang, "sess.pileTitle", { n: group.sessions.length })}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className="session-title session-title-line">
                      <SessionSigil signal={sessionSignal(head)} />
                      <span className="session-name">
                        {head.firstPrompt !== "" ? head.firstPrompt : t(lang, "nav.emptySession")}
                      </span>
                      <span className="pile-count tabular">{group.sessions.length}&times;</span>
                      <svg
                        className="pile-chevron"
                        viewBox="0 0 16 16"
                        width="9"
                        height="9"
                        aria-hidden="true"
                      >
                        <path
                          d="M4 6l4 4 4-4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    </span>
                    <span className="session-meta session-meta-line tabular">
                      <span className="session-facts">
                        {relativeTime(head.startedAt, Date.now(), lang)} &middot;{" "}
                        {countLabel(lang, "token", total, formatTokens(total))}
                      </span>
                      {sessionModelLabel(head) !== "" && (
                        <span className="session-model mono">{sessionModelLabel(head)}</span>
                      )}
                    </span>
                  </button>
                  {open && group.sessions.map((s) => sessionRow(s, true))}
                </div>
              );
            })}
          </nav>

          {sessions !== null && sessions.length === 0 && !failed && (
            <p className="sidebar-note">{t(lang, "nav.none")}</p>
          )}
          {failed && <p className="sidebar-note">{t(lang, "nav.unreachable")}</p>}

          {/* CHAT scenarios only — the fleet ones live under the fleets segment,
              where playing one lands you anyway (owner: the flat mixed list read
              as mush). History first, demos below, each list sorted by kind. */}
          <p className="sidebar-eyebrow scenario-eyebrow">{t(lang, "nav.scenarios")}</p>
          <nav className="session-list scenario-list" aria-label={t(lang, "nav.scenarios")}>
            {SCENARIOS.filter((s) => s.fleet !== true).map((s) => (
              <button
                type="button"
                key={`scenario:${s.id}`}
                className={`session-row scenario-row${props.activeId === `scenario:${s.id}` && props.activeFleet === null ? " active" : ""}`}
                title={loc(s.prompt, lang)}
                onClick={() => props.onSelectScenario(s)}
              >
                <span className="session-title">
                  <svg
                    className="scenario-glyph"
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    aria-hidden="true"
                  >
                    <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
                  </svg>
                  {loc(s.name, lang)}
                </span>
                <span className="session-meta">{lang === "de" ? "szenario · demo" : "scenario · demo"}</span>
              </button>
            ))}
          </nav>
        </>
      ) : (
        <>
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
                    {/* Remove from the list — DONE fleets only (a live one would
                        just reappear with its next frame, so it is not offered). */}
                    {f.onlineCount === 0 && props.onRemoveFleet && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="fleet-row-remove mono"
                        title={
                          lang === "de" ? "Flotte aus der Liste entfernen" : "remove this fleet from the list"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onRemoveFleet!(f.contextId);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            props.onRemoveFleet!(f.contextId);
                          }
                        }}
                      >
                        ×
                      </span>
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

          {/* FLEET scenarios — playing one enters a replay fleet, so they live
              here, under the fleets they become (owner: no more mixed list). */}
          <p className="sidebar-eyebrow scenario-eyebrow">{t(lang, "nav.scenarios")}</p>
          <nav className="session-list scenario-list" aria-label={t(lang, "nav.scenarios")}>
            {SCENARIOS.filter((s) => s.fleet === true).map((s) => (
              <button
                type="button"
                key={`scenario:${s.id}`}
                className={`session-row scenario-row${props.activeFleet === `scenario:${s.id}` ? " active" : ""}`}
                title={loc(s.prompt, lang)}
                onClick={() => props.onSelectScenario(s)}
              >
                <span className="session-title">
                  <svg
                    className="scenario-glyph"
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    aria-hidden="true"
                  >
                    <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
                  </svg>
                  {loc(s.name, lang)}
                </span>
                <span className="session-meta">
                  {lang === "de" ? "flotten-szenario · demo" : "fleet scenario · demo"}
                </span>
              </button>
            ))}
          </nav>
        </>
      )}
    </aside>
  );
}

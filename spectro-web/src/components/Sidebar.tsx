// Session navigation. The rail is a nav LIST: New chat, Scenarios and Starters
// are rows rather than buttons, the three segments are rows rather than a
// segmented control, and Settings is pinned to the foot. The Live row returns
// to the current socket session; every stored session below it opens as a
// replay through the same reducer as the live stream.
//
// The list is flat. It used to fold look-alike rows into a pile with a count
// and a chevron; the owner cut it, and the reason it existed — 229 files from
// one smoke test that still fires — is an upstream mess, not a list problem.
//
// How much a row says is the reader's choice now (card 214): the options control
// at the head of the list carries `density`, and at normal — the default — a row
// is its name and its state dot. What density cuts is not rendered rather than
// hidden, because a rule that hides markup outlives the markup, and this file
// has already paid for that once.

import { useEffect, useState } from "react";
import type { SessionMeta } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatTokens, relativeTime } from "../format";
import { SessionSigil, countLabel, sessionModelLabel, sessionSignal, sessionTitleLines } from "./sessionRows";
import { NavIcon, NavRow } from "./NavRow";
import { navActionRows, navSegmentRows } from "./navRows";
import { RunDot } from "./RunDot";
import { runState, storedRunState, type RunState } from "./runIndicator";
import { useLiveSessions } from "../state/liveSessions";
import { SessionListOptions } from "./SessionListOptions";
import { rowParts, useDensity, type RowParts } from "../state/density";
import { useFleets } from "../state/fleetStore";
import { FleetSigil } from "../spectrum/FleetSigil";
import { SCENARIOS } from "../scenario/registry";
import { ScenarioRail, type LoadedRun } from "../stategraph/StateGraphPane";
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
  /** Opens the settings overlay — the same door the header gear opens. Two
   *  doors on purpose: the header's is the first thing a narrow window takes
   *  away, and the rail is where a reader looks for the app's own switches. */
  onSettings: () => void;
  /** True while THIS page's socket has a run in flight. It drives the rail's
   *  own live row, and it is the FALLBACK for the resumed stored row when
   *  nothing reports a live set (a server from before card 212). Every other
   *  row now reads {@link useLiveSessions} instead. */
  liveRunning: boolean;
  /** The stored session this page's socket is continuing, when it is
   *  continuing one. */
  resumeId: string | null;
  /** Opens the session-import dialog (spectroscope JSONL or Claude Code transcript). */
  onImport: () => void;
  /** Opens the scenario picker modal — kept alongside the inline scenario rows
   *  below (a redundant second path; the owner may retire the modal later). */
  onScenarios: () => void;
  onStarters: () => void;
  /** Play a scenario inline from the list — replays it like a session. */
  onSelectScenario: (dsl: Dsl) => void;
  /** The state-graph run on screen (its source names the active rail row). */
  stateGraphSource: string | null;
  /** Load a bundled state-graph scenario from the rail — replaces the run. */
  onStateGraphScenario: (run: LoadedRun) => void;
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
  nav: "sessions" | "fleets" | "stategraph";
  /** Switch segment. App owns the state so the surface can answer the press. */
  onNav: (next: "sessions" | "fleets" | "stategraph") => void;
  /** Fold the sidebar away. Offered here as well as in the header because the
   *  header's own control is the first thing a narrow window takes away. */
  onCollapse?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const nav = props.nav;
  const lang = useLang();
  const fleets = useFleets();
  // Card 212: which sessions are live ON THIS SERVER, not merely on this page.
  // Pushed over the socket and polled underneath — see state/liveSessions.ts.
  const liveSessions = useLiveSessions();
  // The identity of the live SET, not of its run flags: the stored list has to
  // be refetched when a session appears or disappears (a fresh one has no row
  // in /api/sessions until its file exists), but a run merely starting inside
  // a session that is already listed changes no row's metadata.
  const liveIds = liveSessions.map((session) => session.id).join(",");
  // How much a row says. Read once for the whole list: switching it re-renders
  // what is already in hand and touches no endpoint — the fetch below hangs off
  // props.refreshToken and nothing else.
  const parts = rowParts(useDensity());
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
  }, [props.refreshToken, liveIds]);

  const actionPress: Record<string, () => void> = {
    newChat: props.onNewChat,
    scenarios: props.onScenarios,
    starters: props.onStarters,
  };

  /** Which segment each row asks App for. Spelled out one call at a time
   *  rather than passed through from the row id: App owns `nav`, and this is
   *  the seam where the surface answers the press (card 179). */
  const segmentPress: Record<string, () => void> = {
    sessions: () => props.onNav("sessions"),
    fleets: () => props.onNav("fleets"),
    stategraph: () => props.onNav("stategraph"),
  };

  /**
   * A row-level action, riding INSIDE the row's own button. A nested <button>
   * is invalid markup, so this is the same span+role idiom the fleet row's
   * remove control already uses — and it stops the press from also reaching
   * the segment underneath.
   */
  const rowAction = (className: string, title: string, run: () => void, body: string) => (
    <span
      role="button"
      tabIndex={0}
      className={className}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          run();
        }
      }}
    >
      {body}
    </span>
  );

  /** The row-level action a segment row carries on its right, as markup. */
  const trailingFor = (kind: "import" | "spawn" | "count" | null) => {
    if (kind === "import")
      return rowAction("sidebar-import", t(lang, "nav.importTitle"), props.onImport, "Import");
    if (kind === "spawn")
      return rowAction(
        "sidebar-import sidebar-spawn",
        lang === "de" ? "einen node starten (read-only)" : "spawn a node (read-only)",
        props.onSpawnNode,
        "+ node",
      );
    if (kind === "count") return <span className="sidebar-seg-badge tabular">{fleets.length}</span>;
    return null;
  };

  return (
    <aside className="sidebar">
      {/* Everything down to the sessions/fleets switch is one sticky block, and
          since card 216 the session list's own head rides in it too. The
          collapse control had just moved onto the brand so a narrow window
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

        {/* The three actions, as rows. They were buttons — a filled primary and
          two ghosts — and three boxes at the top of a rail argue with the list
          underneath for the attention the list should win. Scenarios keeps its
          modal alongside the inline scenario rows below (a redundant second
          path; owner may retire it). */}
        <div className="sidebar-nav">
          {navActionRows().map((row) => (
            <NavRow
              key={row.id}
              icon={<NavIcon id={row.icon} />}
              label={t(lang, row.labelKey)}
              title={row.titleKey !== undefined ? t(lang, row.titleKey) : undefined}
              onClick={actionPress[row.id]}
            />
          ))}
        </div>

        {/* The same recipe again for the segments. One hairline separates the
          two groups: without it the rail is one undifferentiated column of
          rows, and "start something" and "look at something" are not the same
          kind of press. */}
        <div className="sidebar-nav sidebar-nav-seg" role="tablist" aria-label={t(lang, "nav.navMode")}>
          {navSegmentRows({
            active: nav,
            fleetsLocked: props.fleetsLocked === true,
            fleetCount: orderedFleets.length,
          }).map((row) => (
            <NavRow
              key={row.id}
              role="tab"
              ariaSelected={row.active}
              active={row.active}
              disabled={row.disabled}
              icon={<NavIcon id={row.icon} />}
              label={t(lang, row.labelKey)}
              trailing={trailingFor(row.trailing)}
              onClick={segmentPress[row.id]}
            />
          ))}
        </div>

        {/* The head of the list, and the options belong to the list rather than
            to the app: they change how THESE rows read, so they sit on them and
            not in the settings overlay at the foot. At the right, where a
            control that governs a column goes.

            It is drawn HERE, as the last row of the sticky block, rather than as
            a sibling above the list — card 216. Static, it left with the list:
            at the bottom of a 112-session rail the trigger sat 4091px above the
            rail's top edge while the settings row was still on screen, so one
            end of the rail was pinned and the other ran away. A second sticky
            child would need `top:` equal to this block's height, and that height
            is a brand plus six nav rows — a number that goes stale on the next
            row anyone adds. Joining the block needs no number.

            The guard, on the segment: the block is drawn on all three segments,
            and options for a list you are not looking at are noise. */}
        {nav === "sessions" && (
          <div className="session-list-head">
            <SessionListOptions />
          </div>
        )}
      </div>

      {nav === "sessions" ? (
        <>
          <nav className="session-list" aria-label="Sessions">
            {/* The live row wears the same dot as every other row. It is THIS
                page's socket — no longer the only row that may say "running",
                only the one that says it about the session you are in. */}
            <button
              type="button"
              className={`session-row live-row${props.activeId === null && props.activeFleet === null ? " active" : ""}`}
              onClick={props.onSelectLive}
            >
              <span className="session-title">
                <RunDot state={runState({ live: true, running: props.liveRunning })} lang={lang} />{" "}
                {t(lang, "nav.live")}
              </span>
              {/* The live row's subline goes quiet with the rest of the list: it
                  is in the same list, under the same control, and "this browser
                  tab" is the one thing the row's own name already says. */}
              {parts.meta && <span className="session-meta">{t(lang, "nav.liveSub")}</span>}
            </button>

            {(sessions ?? []).map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                parts={parts}
                lang={lang}
                active={props.activeId === s.id && props.activeFleet === null}
                /* Card 212 owns the rule and card 214 owns the drawing: the whole
                   live decision stays in storedRunState, where it is tested
                   without a DOM, and the row receives a finished state. */
                state={storedRunState({
                  row: s,
                  live: liveSessions,
                  resumeId: props.resumeId,
                  liveRunning: props.liveRunning,
                })}
                onSelect={() => props.onSelectSession(s.id)}
              />
            ))}
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
      ) : nav === "stategraph" ? (
        /* The scenario rail, the fleet list's idiom — offered PERMANENTLY,
           because the empty-state shelf disappears the moment a run loads
           (owner's call, 2026-08-11). The note stays: files through the
           picker remain the other way in. */
        <>
          <p className="sidebar-note">{t(lang, "nav.stategraphNote")}</p>
          <p className="sidebar-eyebrow scenario-eyebrow">{t(lang, "nav.scenarios")}</p>
          <ScenarioRail active={props.stateGraphSource} onSelect={props.onStateGraphScenario} />
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

      {/* Outside the segment branch on purpose: settings is not a fact about
          sessions, and a control that exists on one of three segments is a
          control a reader learns not to look for. The head solved the same
          problem at the other end of this scroll container. */}
      <div className="sidebar-foot">
        <NavRow icon={<NavIcon id="gear" />} label={t(lang, "hdr.settings")} onClick={props.onSettings} />
      </div>
    </aside>
  );
}

/**
 * One stored session. Flat — there is no second level any more.
 *
 * <p>A component with a name, and EXPORTED, for one reason: the density gate
 * lives in this markup, and while the row was an arrow function inside the
 * component above, the only thing a test could reach was `rowParts()` itself.
 * The fold was pinned nine ways and the wiring was pinned by nothing — the
 * card's whole point could be deleted from this row with the full gate at
 * exit 0, which is what the review of card 214 measured. `sessionRowDensity
 * .test.tsx` now renders this at each density and counts what comes out, so
 * the gate is red when the gate here is gone.</p>
 *
 * <p>What a row draws arrives as `parts` rather than being read from the store
 * here: the list reads the density ONCE for all of its rows, and a subscription
 * per row would change a measured property of this card (switching at 113 rows,
 * median 5.5 ms) for nothing.</p>
 */
export function SessionRow(props: {
  s: SessionMeta;
  /** What this density draws, from `rowParts()` — computed once for the list. */
  parts: RowParts;
  lang: Lang;
  active: boolean;
  /** The dot's state, already decided by storedRunState at the list level. */
  state: RunState;
  onSelect: () => void;
}) {
  const { s, parts, lang } = props;
  return (
    <button
      type="button"
      className={`session-row${props.active ? " active" : ""}`}
      /* ONE hover string, at either density. In normal the hover is the only
         place the cut facts live, and a density-aware second one would be a
         second thing to keep in step with the DTO. */
      title={sessionTitleLines(s, lang)}
      onClick={props.onSelect}
    >
      <span className="session-title session-title-line">
        {/* A stored row is no longer limited to what its file says: the server
            reports the live set (card 212), so a session another window drives
            wears the same dot that window shows. The rule is storedRunState,
            applied by the list; this row only draws the answer.

            The dot survives every density: with the metadata line gone it is the
            only thing left in the row that can say a session is running, and it
            carries its state as a word as well as a hue. */}
        <RunDot state={props.state} lang={lang} />
        {/* The comb is a SECOND glyph, not the dot, so it goes with the metadata
            line: "the session name and the state dot, and nothing else" leaves no
            room for it. It is not deleted — extended draws it exactly as before. */}
        {parts.sigil && <SessionSigil signal={sessionSignal(s)} />}
        <span className="session-name">
          {s.firstPrompt !== "" ? s.firstPrompt : t(lang, "nav.emptySession")}
        </span>
      </span>
      {parts.meta && (
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
      )}
    </button>
  );
}

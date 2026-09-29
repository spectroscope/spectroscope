// Session navigation. The rail is a nav LIST: New chat, Scenarios and Starters
// are rows rather than buttons, the three segments are rows rather than a
// segmented control, and Settings is pinned to the foot. Every session is one
// row (card 458): the ones this page holds a socket to are merged into the
// stored list by id, and there is no separate "Live session" row any more.
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
import { rememberSessionTitles } from "../state/sessionOpening";
import {
  TITLE_POLL_MS,
  deleteStoredSession,
  orderSessions,
  pinSession,
  renameSession,
  suggestSessionTitle,
  titlePending,
  withTitleFields,
  withoutSession,
  type SessionTitleFields,
} from "../state/sessionMeta";
import { SessionGroups } from "./SessionGroups";
import { SessionRowMenu } from "./SessionRowMenu";
import { SessionRenameField } from "./SessionRenameField";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import {
  renameOpening,
  renameRequest,
  rowMenuItems,
  type RenameOpening,
  type RowMenuEntry,
  type RowMenuItemId,
} from "./rowMenuItems";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatTokens, relativeTime } from "../format";
import {
  SessionSigil,
  countLabel,
  sessionDisplayTitle,
  sessionModelLabel,
  sessionSignal,
  sessionTitleLines,
} from "./sessionRows";
import { NavIcon, NavRow } from "./NavRow";
import { navActionRows, navSegmentRows, type NavSegmentId } from "./navRows";
import { RunDot } from "./RunDot";
import { storedRunState, type RunState } from "./runIndicator";
import { deleteQuestion, heldRunState, mergeHeldRows, type HeldRow } from "../state/sessionRows";
import { useLiveSessions } from "../state/liveSessions";
import { SessionListOptions } from "./SessionListOptions";
import { rowParts, useDensity, type RowParts } from "../state/density";
import { useFleets } from "../state/fleetStore";
import { useViewMode } from "../state/viewMode";
import { FleetSigil } from "../spectrum/FleetSigil";
import { SCENARIOS } from "../scenario/registry";
import { ScenarioRail, type LoadedRun } from "../stategraph/scenarios";
import { loc, type Dsl } from "../scenario/dsl";

export function Sidebar(props: {
  /** True while the fleets segment is still ahead on the ladder. The segment
   *  stays visible and dimmed rather than vanishing: a feature nobody can see
   *  is a feature nobody adopts. */
  fleetsLocked?: boolean;
  /** The session on screen, held or stored; null for a fresh chat, a fleet or a demo. */
  activeId: string | null;
  /** Bump to refetch the list (e.g. after a run finished). */
  refreshToken: number;
  /** A click on a session row. App decides what it opens (state/sessionRows.ts). */
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  /** Opens the settings overlay — the same door the header gear opens. Two
   *  doors on purpose: the header's is the first thing a narrow window takes
   *  away, and the rail is where a reader looks for the app's own switches. */
  onSettings: () => void;
  /** Card 458: the sessions this page holds a socket to. Each is merged into
   *  the list by id, and its dot comes from its own record. A server from before
   *  card 212 reports no live set, so this is also the fallback there. */
  held: readonly HeldRow[];
  /** Card 459: lets a held session go (stopping it first when it runs) before
   *  its row menu deletes it. Absent, a held row cannot be deleted. */
  onReleaseHeld?: (id: string) => Promise<void>;
  /** Opens the session-import dialog (spectroscope JSONL or Claude Code transcript). */
  onImport: () => void;
  /** Opens the scenario picker modal — kept alongside the inline scenario rows
   *  below (a redundant second path; the owner may retire the modal later). */
  onScenarios: () => void;
  onStarters: () => void;
  /** True while the skills view is on screen. It marks the Skills row and
   *  nothing else: the list below stays whatever the segment says (card 409). */
  skillsOpen: boolean;
  /** Opens the skills view, beside the list rather than instead of it. */
  onSkills: () => void;
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
  nav: NavSegmentId;
  /** Switch segment. App owns the state so the surface can answer the press. */
  onNav: (next: NavSegmentId) => void;
  /** Fold the sidebar away. Offered here as well as in the header because the
   *  header's own control is the first thing a narrow window takes away. */
  onCollapse?: () => void;
  /** Card 445: a row menu deleted this stored session. App falls back the way
   *  the archive bar's delete does when the session was open. */
  onSessionDeleted?: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Card 445: the row menu's state. One rename, one delete question and any
  // number of suggestions can be under way; the poll tick refetches the list
  // while a fresh session waits for its suggested title. The rename is held as
  // what its field opened with (renameOpening), so a title that lands while
  // the field is open changes neither the field nor what counts as unchanged.
  const [renaming, setRenaming] = useState<RenameOpening | null>(null);
  const [deleting, setDeleting] = useState<{ row: SessionMeta; busy: boolean; failed: boolean } | null>(null);
  const [suggesting, setSuggesting] = useState<ReadonlySet<string>>(new Set());
  const [focusMenuOf, setFocusMenuOf] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const nav = props.nav;
  const lang = useLang();
  // Card 430: a row the surface table closes in this mode is not drawn.
  const mode = useViewMode();
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
  // what is already in hand and touches no endpoint. The density is not a
  // dependency of the fetch below.
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
        // Card 431: an open names the session with its row's words, found by id.
        rememberSessionTitles(list);
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
  }, [props.refreshToken, liveIds, pollTick]);

  // Card 445: a new session's title is asked for in the background when its
  // first run starts, and lands a few seconds later. While a young row still
  // shows its first prompt, look again every TITLE_POLL_MS; titlePending stops
  // this once every row has its title or is past TITLE_WAIT_MS.
  useEffect(() => {
    if (sessions === null || !titlePending(sessions, Date.now())) return;
    const timer = setTimeout(() => setPollTick((n) => n + 1), TITLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [sessions]);

  // Card 445: a pin moves the row to the other group, which draws it anew, so
  // the three-dots button the keyboard was on is a new element. Give focus back
  // to that row's button once it is drawn.
  useEffect(() => {
    if (focusMenuOf === null) return;
    const button = document.querySelector<HTMLButtonElement>(
      `[data-session-id="${CSS.escape(focusMenuOf)}"] .session-menu-btn`,
    );
    button?.focus();
    setFocusMenuOf(null);
  }, [focusMenuOf, sessions]);

  /** Applies a server answer (or an optimistic guess) to one row. */
  const applyFields = (id: string, fields: SessionTitleFields): void => {
    setSessions((list) => (list === null ? list : withTitleFields(list, id, fields)));
  };

  const pickFromMenu = (row: SessionMeta, item: RowMenuItemId): void => {
    if (item === "pin" || item === "unpin") {
      const pinned = item === "pin";
      const before: SessionTitleFields = {
        title: row.title,
        titleSource: row.titleSource,
        pinned: row.pinned,
      };
      applyFields(row.id, { ...before, pinned });
      setFocusMenuOf(row.id);
      void pinSession(row.id, pinned).then((answer) => applyFields(row.id, answer ?? before));
    } else if (item === "rename") {
      setRenaming(renameOpening(row, lang));
    } else if (item === "suggest") {
      setSuggesting((set) => new Set(set).add(row.id));
      setFocusMenuOf(row.id);
      void suggestSessionTitle(row.id).then((answer) => {
        if (answer !== null) applyFields(row.id, answer.fields);
        setSuggesting((set) => {
          const next = new Set(set);
          next.delete(row.id);
          return next;
        });
      });
    } else {
      setDeleting({ row, busy: false, failed: false });
    }
  };

  /**
   * @param row    the row as it is when the field closes (id, pin, and the
   *               fields to put back when the server refuses)
   * @param opened what the field opened with; the typed text is compared with it
   */
  const finishRename = (
    row: SessionMeta,
    opened: RenameOpening,
    typed: string | null,
    by: "key" | "blur",
  ): void => {
    setRenaming(null);
    // After Enter or Escape the keyboard goes back to the row's button. After a
    // blur the operator has already put focus somewhere else, and it stays there.
    if (by === "key") setFocusMenuOf(row.id);
    if (typed === null) return;
    const title = renameRequest({ typed, shown: opened.shown, hasTitle: opened.hasTitle });
    if (title === null) return;
    const before: SessionTitleFields = { title: row.title, titleSource: row.titleSource, pinned: row.pinned };
    // Shown at once; the answer then says what the server kept (for an emptied
    // field, the suggestion or nothing).
    if (title !== "") applyFields(row.id, { title, titleSource: "manual", pinned: row.pinned });
    void renameSession(row.id, title).then((answer) => applyFields(row.id, answer ?? before));
  };

  const confirmDelete = (): void => {
    if (deleting === null) return;
    const row = deleting.row;
    setDeleting({ row, busy: true, failed: false });
    // Card 459: a session this page holds lets its socket go first (a running
    // one is stopped and given until its run_end), so no run appends to the
    // file after it is deleted.
    const held = props.held.some((h) => h.id === row.id);
    const released =
      held && props.onReleaseHeld !== undefined ? props.onReleaseHeld(row.id) : Promise.resolve();
    void released
      .then(() => deleteStoredSession(row.id))
      .then((outcome) => {
        if (outcome === "failed") {
          setDeleting({ row, busy: false, failed: true });
          return;
        }
        setDeleting(null);
        setSessions((list) => (list === null ? list : withoutSession(list, row.id)));
        props.onSessionDeleted?.(row.id);
      });
  };

  const cancelDelete = (): void => {
    if (deleting !== null) setFocusMenuOf(deleting.row.id);
    setDeleting(null);
  };

  const actionPress: Record<string, () => void> = {
    newChat: props.onNewChat,
    scenarios: props.onScenarios,
    starters: props.onStarters,
    skills: props.onSkills,
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

        {/* The actions, as rows. They were buttons (a filled primary and
          two ghosts), and three boxes at the top of a rail argue with the list
          underneath for the attention the list should win. Scenarios keeps its
          modal alongside the inline scenario rows below (a redundant second
          path; owner may retire it). Skills is the fourth since card 409, and
          like the other three it leaves the list below alone. */}
        <div className="sidebar-nav">
          {navActionRows({ skillsOpen: props.skillsOpen, mode }).map((row) => (
            <NavRow
              key={row.id}
              surface={row.id}
              active={row.active}
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
          kind of press.

          The options control rode this group's last line from card 217 until
          card 464 gave the list a head row of its own below it. */}
        <div className="sidebar-nav-seg-line">
          <div className="sidebar-nav sidebar-nav-seg" role="tablist" aria-label={t(lang, "nav.navMode")}>
            {navSegmentRows({
              active: nav,
              fleetsLocked: props.fleetsLocked === true,
              fleetCount: orderedFleets.length,
              mode,
            }).map((row) => (
              <NavRow
                key={row.id}
                surface={row.id}
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
        </div>

        {/* Card 464 (owner, 2026-09-29): "dass Sessions links steht, Import in
            der Mitte und diese kleinen Einstellungen rechts". The list's own
            head row, above the rows, inside the block that does not scroll
            (card 216): the options change how THESE rows read, and Import
            fills this list. On the sessions segment only. */}
        {nav === "sessions" && (
          <div className="session-list-head">
            <span className="session-list-caption">{t(lang, "nav.sessions")}</span>
            <button
              type="button"
              className="sidebar-import"
              title={t(lang, "nav.importTitle")}
              onClick={props.onImport}
            >
              Import
            </button>
            <SessionListOptions />
          </div>
        )}
      </div>

      {/* THE scroll container of the rail (card 217). The bar belonged to
          `.sidebar`, so it spanned the brand, six nav rows and the settings foot
          as well as the sessions it moves — 364.7px of chrome measured on a
          1440x900 window. It spans the rows now, and the fixed blocks stand
          outside it at both ends. */}
      <div className="sidebar-list">
        {nav === "sessions" ? (
          <>
            <nav className="session-list" aria-label="Sessions">
              {/* Card 445: pinned sessions head the list under their own
                  heading; the rest follow, the live row first as before. */}
              <SessionGroups
                lang={lang}
                groups={orderSessions(mergeHeldRows(sessions ?? [], props.held))}
                row={(s) => {
                  /* Card 212 owns the rule and card 214 owns the drawing: the whole
                   live decision stays in storedRunState, where it is tested
                   without a DOM, and the row receives a finished state. A row
                   this page holds reads its own record first (card 458). */
                  const mine = props.held.find((h) => h.id === s.id);
                  const state =
                    mine !== undefined
                      ? heldRunState(mine)
                      : storedRunState({ row: s, live: liveSessions, resumeId: null, liveRunning: false });
                  const question = deleteQuestion(s.id, {
                    held: props.held,
                    liveElsewhere: liveSessions.map((row) => row.id),
                  });
                  return (
                    <SessionRow
                      key={s.id}
                      s={s}
                      parts={parts}
                      lang={lang}
                      active={props.activeId === s.id && props.activeFleet === null}
                      state={state}
                      attention={mine?.attention ?? null}
                      onSelect={() => props.onSelectSession(s.id)}
                      menu={{
                        items: rowMenuItems({
                          pinned: s.pinned === true,
                          hasTitle: (s.title ?? "").trim() !== "" || suggesting.has(s.id),
                          // Card 459: a session this page holds is let go first
                          // (stopped when it runs, after asking); one another
                          // window holds is not deleted from here.
                          deletable:
                            question === "plain" ||
                            (question !== "refused" && props.onReleaseHeld !== undefined),
                        }),
                        onPick: (item) => pickFromMenu(s, item),
                      }}
                      renameFrom={renaming !== null && renaming.id === s.id ? renaming.shown : undefined}
                      onRename={(typed, by) => {
                        if (renaming !== null) finishRename(s, renaming, typed, by);
                      }}
                      suggesting={suggesting.has(s.id)}
                    />
                  );
                }}
              />
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
                  <span className="session-meta">
                    {lang === "de" ? "szenario · demo" : "scenario · demo"}
                  </span>
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
                            lang === "de"
                              ? "Flotte aus der Liste entfernen"
                              : "remove this fleet from the list"
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
      </div>

      {/* Outside the segment branch on purpose: settings is not a fact about
          sessions, and a control that exists on one of three segments is a
          control a reader learns not to look for. The head solved the same
          problem at the other end of the rail. */}
      <div className="sidebar-foot">
        <NavRow icon={<NavIcon id="gear" />} label={t(lang, "hdr.settings")} onClick={props.onSettings} />
      </div>

      {deleting !== null && (
        <SessionDeleteDialog
          lang={lang}
          title={sessionDisplayTitle(deleting.row, lang)}
          running={props.held.some((h) => h.id === deleting.row.id && h.running)}
          busy={deleting.busy}
          failed={deleting.failed}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      )}
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
  /** Card 459: what the held session asks of the reader, drawn after its name. */
  attention?: HeldRow["attention"];
  onSelect: () => void;
  /** Card 445: the row's three-dots menu. Absent, the row has none (the
   *  density tests draw rows without one). */
  menu?: { items: RowMenuEntry[]; onPick: (item: RowMenuItemId) => void };
  /** Card 445: while the title is a rename field, the text the field opened
   *  with, noted by the list when Rename was picked. Absent otherwise. */
  renameFrom?: string;
  /** Card 445: the rename field closed, with the typed text or null for
   *  cancel, and whether a key or a blur closed it. */
  onRename?: (typed: string | null, by: "key" | "blur") => void;
  /** Card 445: a suggestion for this row is on its way. */
  suggesting?: boolean;
}) {
  const { s, parts, lang } = props;
  const shown = sessionDisplayTitle(s, lang);
  const hover = sessionTitleLines(s, lang);
  return (
    <div
      className={`session-item${props.active ? " active" : ""}`}
      data-session-id={s.id}
      aria-busy={props.suggesting === true ? true : undefined}
    >
      {props.renameFrom !== undefined ? (
        <SessionRenameField
          lang={lang}
          initial={props.renameFrom}
          onDone={(typed, by) => props.onRename?.(typed, by)}
        />
      ) : (
        <button
          type="button"
          className={`session-row${props.active ? " active" : ""}`}
          /* ONE hover string, at either density. In normal the hover is the only
             place the cut facts live, and a density-aware second one would be a
             second thing to keep in step with the DTO. */
          title={hover}
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
            {/* Card 445: the title when the row has one, else the first prompt. */}
            <span className="session-name">{shown}</span>
            {props.attention === "answer" && (
              <span className="session-wait session-wait--answer">{t(lang, "nav.waitingForYou")}</span>
            )}
            {props.attention === "model" && (
              <span className="session-wait">{t(lang, "nav.waitingForModel")}</span>
            )}
          </span>
          {parts.meta && (
            <span className="session-meta session-meta-line tabular">
              <span className="session-facts">
                {relativeTime(s.startedAt, Date.now(), lang)}
                {(s.turnCount ?? 0) > 0 && <> &middot; {countLabel(lang, "turn", s.turnCount ?? 0)}</>}{" "}
                &middot; {countLabel(lang, "token", s.tokens, formatTokens(s.tokens))}
              </span>
              {/* The model only earns a place once the rail is wide enough to spell
                  it out — see the container query. Truncated to "claude-s…" it answers
                  nothing, and it would be answering it with the token count's space. */}
              {sessionModelLabel(s) !== "" && (
                <span className="session-model mono">{sessionModelLabel(s)}</span>
              )}
            </span>
          )}
        </button>
      )}
      {/* Card 445: at the row's right end, a sibling of the row button (a
          button inside a button is invalid markup). Hidden while renaming. */}
      {props.menu !== undefined && props.renameFrom === undefined && (
        <SessionRowMenu lang={lang} title={shown} items={props.menu.items} onPick={props.menu.onPick} />
      )}
    </div>
  );
}

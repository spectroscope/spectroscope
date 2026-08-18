// The composer's plus menu (card 224): the fast switch for skills and MCP
// servers, where the hand already is. Two submenus, one model — every row a
// switch with a one-line truth (a skill's description, the COMMAND an MCP
// server runs), and each submenu ends with Manage/Browse rows that open the
// settings page. Nothing is removed from settings: the menu flips, the page
// stays the full account.
//
// What this file may claim is bounded by two cards. Card 222: a switch says
// which run its change applies to, and the sentence is DERIVED (ReachBlock
// over SETTING_REACH), never hand-written — both kinds land at the next agent
// build, and the current run's belt is untouched. Card 221: the lists come
// from the SERVED config (GET /api/skills reads the roots, GET /api/settings
// serves the resolved mcpServers block) and never from a live probe — a mute
// server hangs a dial, and this menu must never block on opening. The web
// face has no registry handle (measured on card 221), so an MCP row does not
// know whether its server answered last time and does not pretend to:
// reachability lives in `spectro doctor` and the REPL's /mcp.
//
// File name ends in Settings.tsx ON PURPOSE: settingsReach.test.tsx walks
// every such file, so the mcpServers/skills switches here sit under the same
// guard as the settings page's own.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler, ReactNode, RefObject } from "react";
import type { WorkspaceInfo } from "../state/reducer";
import { fetchSettings, putSettings, type SettingsView } from "../state/serverSettings";
import { skillPath } from "../state/skillInstall";
import { mcpModel, toggledMcpBlock, type McpScope } from "./plusMenu";
import { ReachBlock } from "./settingsReach";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** One /api/skills row — the same shape SkillsSettings reads. */
export interface SkillRow {
  name: string;
  folder: string;
  pack: string | null;
  description: string;
  source: "user" | "project";
  disabled: boolean;
}

type SubMenu = "skills" | "mcp";

/** The row focus/active classes, shared by every menu row in this file. */
const rowClass = (focused: boolean, active = false): string =>
  `wsg-mode-row plus-row${focused ? " wsg-mode-row--focus" : ""}${active ? " wsg-mode-row--active" : ""}`;

const switchGlyph = (on: boolean): ReactNode => (
  <span className={`thinking-toggle plus-row-switch${on ? " thinking-toggle--on" : ""}`} aria-hidden="true">
    <span className="thinking-toggle-track">
      <span className="thinking-toggle-knob" />
    </span>
  </span>
);

/** The settings sections the Manage/Browse rows open — route.ts literals. */
export type PlusMenuSection = "skills" | "skills-catalogue" | "mcp";

export function PlusMenu({
  workspaceInfo,
  onOpenSettings,
}: {
  /** This session's workspace announcement — null before it arrives. Supplies
   *  the session id so the settings view is the SESSION-scoped one, the same
   *  layers buildAgentOnce resolves for this session's next build. */
  workspaceInfo: WorkspaceInfo | null;
  /** App's settings opener, with its history manners — the menu never
   *  navigates on its own. */
  onOpenSettings: (section: PlusMenuSection) => void;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<SubMenu | null>(null);
  const [skills, setSkills] = useState<SkillRow[] | null | "failed">(null);
  const [view, setView] = useState<SettingsView | null | "failed">(null);
  const [rootIdx, setRootIdx] = useState(0);
  const [subIdx, setSubIdx] = useState(0);
  // What moved the submenu's index last. The pointer and the arrow keys share
  // ONE index (hover has marked the row here since card 224), and only the
  // arrows are worth scrolling for — see the effect below.
  const subIdxCause = useRef<"key" | "pointer">("key");
  const ref = useRef<HTMLDivElement>(null);
  const rootListRef = useRef<HTMLDivElement>(null);
  const subListRef = useRef<HTMLDivElement>(null);

  const sessionId = workspaceInfo?.sessionId;

  // Both lists, fresh on every open — the settings page or another tab may
  // have flipped something since. Neither fetch can block the menu: the two
  // panels draw "…" until their answer lands, and a failure is said
  // (doc.unreachable) rather than drawn as an empty shelf.
  const load = useCallback((): void => {
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res) => setSkills((res as { skills: SkillRow[] }).skills))
      .catch(() => setSkills("failed"));
    fetchSettings(sessionId)
      .then(setView)
      .catch(() => setView("failed"));
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setSkills(null);
    setView(null);
    setSub(null);
    setRootIdx(0);
    load();
  }, [open, load]);

  // Close on outside click / Escape — same mechanics as ComposerGear.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus follows the open pane, so the arrow keys work without a click — a
  // menu that opens without moving focus strands keyboard users (the
  // DisclosureMenu comment, and it is as true one level deeper).
  useEffect(() => {
    if (!open) return;
    if (sub === null) rootListRef.current?.focus();
    else subListRef.current?.focus();
  }, [open, sub]);

  // Card 260: the arrow keys move an INDEX, not the browser's focus — the group
  // holds focus and the current row is marked with a class. So nothing scrolls
  // on its own, and the moment the entries got a bounded well the keyboard
  // could walk to a row nobody can see. `block: "nearest"` moves the nearest
  // scrollable ancestor by the least it can, which is the well and never the
  // page.
  //
  // A hover is NOT worth a scroll, and the review measured why the first cut of
  // this was wrong: `block: "nearest"` is a fixpoint only for a row that is
  // FULLY visible. A row clipped by the well's edge — exactly what sits under a
  // pointer parked near that edge while the wheel runs — costs up to a whole
  // row of counter-scroll, so the list bounced against the gesture by 17–55px
  // (against 0px with the pointer in the middle of the well). The index
  // therefore remembers what moved it.
  useEffect(() => {
    if (!open || sub === null) return;
    if (subIdxCause.current === "pointer") return;
    const row = subListRef.current?.querySelector(`[data-sub-index="${subIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, sub, subIdx, skills, view]);

  const openSub = (which: SubMenu): void => {
    setSub(which);
    subIdxCause.current = "key";
    setSubIdx(0);
  };

  /** The hover's way of marking a row: the same index, minus the scroll. */
  const focusSubRow = (index: number): void => {
    subIdxCause.current = "pointer";
    setSubIdx(index);
  };

  const toggleSkill = (row: SkillRow): void => {
    fetch(`${skillPath(row.pack, row.folder)}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !row.disabled }),
    })
      .then(load)
      .catch(load);
  };

  const mcp = view === "failed" ? null : mcpModel(view);
  // A project/local-owned block needs the session id on the PUT; without one
  // there is nothing this menu may honestly write.
  const mcpWritable = mcp?.scope === "user" || (mcp?.scope != null && sessionId !== undefined);

  const toggleServer = (name: string): void => {
    if (view === null || view === "failed" || !mcpWritable) return;
    const next = toggledMcpBlock(view, name);
    const scope = mcpModel(view)?.scope;
    if (next === null || scope == null) return;
    // Literal scope per call, so the reach walker sees the field being saved.
    const put = (s: McpScope): Promise<unknown> => {
      if (s === "user") return putSettings("user", { mcpServers: next });
      if (s === "project") return putSettings("project", { mcpServers: next }, sessionId);
      return putSettings("local", { mcpServers: next }, sessionId);
    };
    put(scope).then(load).catch(load);
  };

  const pick = (section: PlusMenuSection): void => {
    setOpen(false);
    onOpenSettings(section);
  };

  // ---- keyboard: root level ----
  const ROOT_ITEMS: SubMenu[] = ["skills", "mcp"];
  const onRootKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setRootIdx((i) => Math.min(ROOT_ITEMS.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setRootIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      const picked = ROOT_ITEMS[rootIdx];
      if (picked !== undefined) openSub(picked);
    }
  };

  // ---- keyboard: submenu level. One index space over rows + Manage/Browse,
  // so Tab is never needed inside the menu. ----
  interface SubItem {
    key: string;
    activate: () => void;
  }
  const subItems: SubItem[] = [];
  if (sub === "skills" && Array.isArray(skills)) {
    for (const row of skills) {
      subItems.push({ key: `s:${row.name}:${row.source}`, activate: () => toggleSkill(row) });
    }
  }
  if (sub === "skills") {
    subItems.push({ key: "manage-skills", activate: () => pick("skills") });
    subItems.push({ key: "browse-skills", activate: () => pick("skills-catalogue") });
  }
  if (sub === "mcp" && mcp !== null) {
    for (const row of mcp.rows) {
      subItems.push({ key: `m:${row.name}`, activate: () => toggleServer(row.name) });
    }
  }
  if (sub === "mcp") {
    subItems.push({ key: "manage-mcp", activate: () => pick("mcp") });
  }
  const onSubKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    // Whatever this key does to the index, the keyboard did it — and a row the
    // keyboard walked to has to come into view.
    subIdxCause.current = "key";
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSubIdx((i) => Math.min(Math.max(subItems.length - 1, 0), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSubIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSub(null);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      subItems[subIdx]?.activate();
    }
  };

  return (
    <div className="wsg-anchor plus-anchor" ref={ref}>
      <button
        type="button"
        className="icon-button attach-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(lang, "plus.title")}
        title={t(lang, "plus.title")}
        onClick={() => setOpen((o) => !o)}
      >
        {/* A plus — the reference's affordance, no emoji. */}
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>

      {open && (
        <div className="wsg-pop plus-pop" role="menu" aria-label={t(lang, "plus.title")}>
          <div
            className="wsg-modes plus-root"
            role="group"
            aria-label={t(lang, "plus.title")}
            tabIndex={0}
            ref={rootListRef}
            onKeyDown={onRootKeyDown}
          >
            {ROOT_ITEMS.map((item, i) => (
              <div
                key={item}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub === item}
                className={rowClass(i === rootIdx, sub === item)}
                onMouseEnter={() => {
                  setRootIdx(i);
                  // The reference opens on hover; keyboard opens on Enter/Right.
                  openSub(item);
                }}
                onClick={() => openSub(item)}
              >
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name">
                    {t(lang, item === "skills" ? "plus.skills" : "plus.mcp")}
                  </span>
                </span>
                <span className="plus-caret" aria-hidden="true">
                  ▸
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {open && sub !== null && (
        <PlusSubmenu
          lang={lang}
          sub={sub}
          skills={skills}
          view={view}
          mcpWritable={mcpWritable}
          subIdx={subIdx}
          itemCount={subItems.length}
          listRef={subListRef}
          onKeyDown={onSubKeyDown}
          onFocusRow={focusSubRow}
          onToggleSkill={toggleSkill}
          onToggleServer={toggleServer}
          onPick={pick}
        />
      )}
    </div>
  );
}

/**
 * The second popover: one submenu's switches, and the rows that lead out of it.
 *
 * Card 260: the entry rows live in `.plus-scroll`, a well of their own, and the
 * footer — the reach sentence, the separator, Manage/Browse — is a sibling of
 * it. Before that everything sat in one `.wsg-modes` group, and since that
 * group declares `overflow: hidden` for its corners it SHRANK inside the
 * bounded popover instead of overflowing it: 36 installed skills drew 2277px of
 * rows into a 444px box, 28 of them plus both footer rows unreachable, and the
 * popover's own `overflow-y: auto` had nothing left to scroll. The well is the
 * only scroller now, and it is the same well for both lists.
 *
 * Exported so a render test can hold it open. The panel draws itself from
 * fetched state, and this suite has no DOM to open it with — but it renders,
 * and which box a row sits in is a claim about markup.
 */
export function PlusSubmenu({
  lang,
  sub,
  skills,
  view,
  mcpWritable,
  subIdx,
  itemCount,
  listRef,
  onKeyDown,
  onFocusRow,
  onToggleSkill,
  onToggleServer,
  onPick,
}: {
  lang: Lang;
  sub: SubMenu;
  skills: SkillRow[] | null | "failed";
  view: SettingsView | null | "failed";
  /** Whether a toggle here has a writable owning layer to land in. */
  mcpWritable: boolean;
  /** The arrow keys' current position in the index space below. */
  subIdx: number;
  /** How many items the arrow keys count over — entries plus the footer rows.
   *  Passed rather than recomputed: the parent's `subItems` is what Enter
   *  activates, and two derivations of the same list drift. */
  itemCount: number;
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onFocusRow: (index: number) => void;
  onToggleSkill: (row: SkillRow) => void;
  onToggleServer: (name: string) => void;
  onPick: (section: PlusMenuSection) => void;
}) {
  const mcp = view === "failed" ? null : mcpModel(view);
  const loadingLine = <p className="settings-note plus-note">…</p>;
  const failedLine = <p className="settings-note plus-note">{t(lang, "doc.unreachable")}</p>;
  const label = t(lang, sub === "skills" ? "plus.skills" : "plus.mcp");

  return (
    <div className="wsg-pop plus-sub" role="menu" aria-label={label}>
      <div
        className="wsg-modes plus-items"
        role="group"
        aria-label={label}
        tabIndex={0}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {sub === "skills" && (
          <ReachBlock lang={lang} fields={["skills"]}>
            <div className="plus-scroll">
              {skills === "failed" ? (
                failedLine
              ) : skills === null ? (
                loadingLine
              ) : skills.length === 0 ? (
                <p className="settings-note plus-note">{t(lang, "skset.empty")}</p>
              ) : (
                skills.map((row, i) => (
                  <div
                    key={`${row.source}:${row.name}`}
                    role="menuitemcheckbox"
                    aria-checked={!row.disabled}
                    data-sub-index={i}
                    className={rowClass(i === subIdx)}
                    title={t(lang, row.disabled ? "skset.enable" : "skset.disable")}
                    onMouseEnter={() => onFocusRow(i)}
                    onClick={() => onToggleSkill(row)}
                  >
                    {switchGlyph(!row.disabled)}
                    <span className="wsg-mode-body">
                      <span className="wsg-mode-name mono">{row.name}</span>
                      <span className="wsg-mode-hint plus-desc">{row.description}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </ReachBlock>
        )}

        {sub === "mcp" && (
          <ReachBlock lang={lang} fields={["mcpServers"]}>
            <div className="plus-scroll">
              {view === "failed" ? (
                failedLine
              ) : mcp === null ? (
                loadingLine
              ) : mcp.rows.length === 0 ? (
                <p className="settings-note plus-note">{t(lang, "mcpset.empty")}</p>
              ) : (
                mcp.rows.map((row, i) => (
                  <div
                    key={row.name}
                    role="menuitemcheckbox"
                    aria-checked={row.enabled}
                    aria-disabled={!mcpWritable}
                    data-sub-index={i}
                    className={rowClass(i === subIdx)}
                    title={t(lang, row.enabled ? "skset.disable" : "skset.enable")}
                    onMouseEnter={() => onFocusRow(i)}
                    onClick={() => onToggleServer(row.name)}
                  >
                    {switchGlyph(row.enabled)}
                    <span className="wsg-mode-body">
                      <span className="wsg-mode-name mono">{row.name}</span>
                      {/* What turning it on runs — "npx -y tavily-mcp".
                          A person sees the command before the switch. */}
                      <span className="wsg-mode-hint plus-desc mono">{row.target}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
            {mcp !== null && mcp.rows.length > 0 && !mcpWritable && (
              <p className="settings-note plus-note">
                {t(lang, "plus.mcpReadOnly", {
                  layer:
                    view !== null && view !== "failed" ? (view.origins["mcpServers"]?.winner ?? "?") : "?",
                })}
              </p>
            )}
          </ReachBlock>
        )}

        <div className="plus-sep" role="separator" aria-hidden="true" />

        {sub === "skills" && (
          <>
            <div
              role="menuitem"
              data-sub-index={itemCount - 2}
              className={rowClass(subIdx === itemCount - 2)}
              onMouseEnter={() => onFocusRow(itemCount - 2)}
              onClick={() => onPick("skills")}
            >
              <span className="wsg-mode-body">
                <span className="wsg-mode-name">{t(lang, "plus.manageSkills")}</span>
              </span>
            </div>
            <div
              role="menuitem"
              data-sub-index={itemCount - 1}
              className={rowClass(subIdx === itemCount - 1)}
              onMouseEnter={() => onFocusRow(itemCount - 1)}
              onClick={() => onPick("skills-catalogue")}
            >
              <span className="wsg-mode-body">
                <span className="wsg-mode-name">{t(lang, "plus.browseSkills")}</span>
              </span>
            </div>
          </>
        )}
        {sub === "mcp" && (
          <div
            role="menuitem"
            data-sub-index={itemCount - 1}
            className={rowClass(subIdx === itemCount - 1)}
            onMouseEnter={() => onFocusRow(itemCount - 1)}
            onClick={() => onPick("mcp")}
          >
            <span className="wsg-mode-body">
              <span className="wsg-mode-name">{t(lang, "plus.manageMcp")}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

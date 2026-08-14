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
import type { KeyboardEventHandler, ReactNode } from "react";
import type { WorkspaceInfo } from "../state/reducer";
import { fetchSettings, putSettings, type SettingsView } from "../state/serverSettings";
import { skillPath } from "../state/skillInstall";
import { mcpModel, toggledMcpBlock, type McpScope } from "./plusMenu";
import { ReachBlock } from "./settingsReach";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** One /api/skills row — the same shape SkillsSettings reads. */
interface SkillRow {
  name: string;
  folder: string;
  pack: string | null;
  description: string;
  source: "user" | "project";
  disabled: boolean;
}

type SubMenu = "skills" | "mcp";

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

  const openSub = (which: SubMenu): void => {
    setSub(which);
    setSubIdx(0);
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

  /** The row focus/active classes, shared by every menu row here. */
  const rowClass = (focused: boolean, active = false): string =>
    `wsg-mode-row plus-row${focused ? " wsg-mode-row--focus" : ""}${active ? " wsg-mode-row--active" : ""}`;

  const switchGlyph = (on: boolean): ReactNode => (
    <span className={`thinking-toggle plus-row-switch${on ? " thinking-toggle--on" : ""}`} aria-hidden="true">
      <span className="thinking-toggle-track">
        <span className="thinking-toggle-knob" />
      </span>
    </span>
  );

  const loadingLine = <p className="settings-note plus-note">…</p>;
  const failedLine = <p className="settings-note plus-note">{t(lang, "doc.unreachable")}</p>;

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
        <div
          className="wsg-pop plus-sub"
          role="menu"
          aria-label={t(lang, sub === "skills" ? "plus.skills" : "plus.mcp")}
        >
          <div
            className="wsg-modes plus-items"
            role="group"
            aria-label={t(lang, sub === "skills" ? "plus.skills" : "plus.mcp")}
            tabIndex={0}
            ref={subListRef}
            onKeyDown={onSubKeyDown}
          >
            {sub === "skills" && (
              <ReachBlock lang={lang} fields={["skills"]}>
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
                      className={rowClass(i === subIdx)}
                      title={t(lang, row.disabled ? "skset.enable" : "skset.disable")}
                      onMouseEnter={() => setSubIdx(i)}
                      onClick={() => toggleSkill(row)}
                    >
                      {switchGlyph(!row.disabled)}
                      <span className="wsg-mode-body">
                        <span className="wsg-mode-name mono">{row.name}</span>
                        <span className="wsg-mode-hint plus-desc">{row.description}</span>
                      </span>
                    </div>
                  ))
                )}
              </ReachBlock>
            )}

            {sub === "mcp" && (
              <ReachBlock lang={lang} fields={["mcpServers"]}>
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
                      className={rowClass(i === subIdx)}
                      title={t(lang, row.enabled ? "skset.disable" : "skset.enable")}
                      onMouseEnter={() => setSubIdx(i)}
                      onClick={() => toggleServer(row.name)}
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
                {mcp !== null && mcp.rows.length > 0 && !mcpWritable && (
                  <p className="settings-note plus-note">
                    {t(lang, "plus.mcpReadOnly", {
                      layer:
                        view !== null && view !== "failed"
                          ? (view.origins["mcpServers"]?.winner ?? "?")
                          : "?",
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
                  className={rowClass(subIdx === subItems.length - 2)}
                  onMouseEnter={() => setSubIdx(subItems.length - 2)}
                  onClick={() => pick("skills")}
                >
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name">{t(lang, "plus.manageSkills")}</span>
                  </span>
                </div>
                <div
                  role="menuitem"
                  className={rowClass(subIdx === subItems.length - 1)}
                  onMouseEnter={() => setSubIdx(subItems.length - 1)}
                  onClick={() => pick("skills-catalogue")}
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
                className={rowClass(subIdx === subItems.length - 1)}
                onMouseEnter={() => setSubIdx(subItems.length - 1)}
                onClick={() => pick("mcp")}
              >
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name">{t(lang, "plus.manageMcp")}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

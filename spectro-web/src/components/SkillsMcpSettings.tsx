// The skill + MCP managers (card 90). Since card 228 they live in DIFFERENT
// homes: SkillsSettings is mounted by the rail's Skills view (SkillsPane) —
// the skills' one place to look, switch, install and remove — while
// McpSettings stays on the settings page. Both stay in THIS file on purpose:
// settingsReach.test.tsx walks *Settings.tsx files, and a manager moved out
// of its sight would save settings with no reach sentence (finding F10).
//
// Skills: both roots listed (disabled ones included — the loader hides them,
// the manager must not), per-skill on/off via the .disabled marker, delete
// for user-root skills (two-step), install from the shipped catalogue. MCP:
// a friendly list over the USER scope's mcpServers block with add/remove —
// the composer gear's raw project-scope editor stays the escape hatch.
// Both managers say honestly that changes reach NEW sessions.

import { useCallback, useEffect, useState } from "react";
import { fetchSettings, putSettings } from "../state/serverSettings";
import {
  installSet,
  installSkill,
  removeSet,
  removeSkill,
  skillPath,
  useInstallState,
  usePackState,
  useRowRemoval,
  type CatalogueRow,
  type InstallRefusal,
  type PackRefusal,
  type SetAction,
} from "../state/skillInstall";
import {
  installedGroups,
  packGroups,
  type InstalledNamespace,
  type InstalledSkill,
  type PackGroup,
} from "../state/skillPacks";
import { mcpTarget } from "./plusMenu";
import { ReachBlock } from "./settingsReach";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

type SkillRow = InstalledSkill;

/** An armed delete disarms after this long — the archive-delete pattern. */
const DELETE_ARM_TIMEOUT_MS = 4000;

export function SkillsSettings({
  anchorId,
  catalogueAnchorId,
  onSettled,
  headed = true,
}: {
  /** A deep-link anchor id, when a page still hosts one. Unused since the
   *  manager moved to the Skills view (card 228) — the App redirects
   *  #/settings/skills there instead. */
  anchorId?: string;
  /** The catalogue's anchor, same story. */
  catalogueAnchorId?: string;
  /** Fires once this block's own fetch has answered (rows or the failure
   *  line — either way the block has its height). */
  onSettled?: () => void;
  /** False when the host draws its own heading (the Skills view's h2) — two
   *  titles for one list read as two lists. */
  headed?: boolean;
} = {}) {
  const lang = useLang();
  const [skills, setSkills] = useState<SkillRow[] | null | "failed">(null);
  const [catalogue, setCatalogue] = useState<CatalogueRow[] | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const { refused } = useInstallState();

  const load = useCallback((): void => {
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res) => {
        const body = res as { skills: SkillRow[]; catalogue?: CatalogueRow[] };
        setSkills(body.skills);
        // A build without the catalogue resource answers without the field;
        // that is an empty shelf, not a failure of the whole panel.
        setCatalogue(body.catalogue ?? []);
        onSettled?.();
      })
      .catch(() => {
        setSkills("failed");
        onSettled?.();
      });
  }, [onSettled]);
  useEffect(load, [load]);

  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), DELETE_ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const toggle = (row: SkillRow): void => {
    fetch(`${skillPath(row.pack, row.folder)}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !row.disabled }),
    })
      .then(load)
      .catch(load);
  };

  const remove = (row: SkillRow): void => {
    if (armed !== row.name) {
      setArmed(row.name);
      return;
    }
    setArmed(null);
    fetch(skillPath(row.pack, row.folder), { method: "DELETE" }).then(load).catch(load);
  };

  // The install itself lives in state/skillInstall — it is the one call in this
  // panel that may NOT be swallowed, and the rules that make it honest (one at
  // a time, a refusal is said, a refusal does not reload) are pinned there.
  // Since card 410 the shelf's rows call it from CataloguePack.
  const installMessage =
    refused === null
      ? null
      : refused.status === 409
        ? t(lang, "skset.nameTaken")
        : t(lang, "skset.installFailed", { error: refused.reason });

  return (
    <div className="skset">
      {headed && (
        <div className="settings-label" id={anchorId}>
          {t(lang, "skset.title")}
        </div>
      )}
      <p className="settings-note">{t(lang, "skset.note")}</p>
      {/* Card 224: when a flipped switch lands is DERIVED, the same sentence
          the plus menu renders — SkillLibrary.load runs inside buildAgentOnce,
          per connection, so the marker written here is read by the next agent
          build. The hand-written reach clause skset.note used to carry is gone:
          a free-text claim beside a derived one is two claims about one thing
          (the mcpset.note comment below made the same move on F10). */}
      <ReachBlock lang={lang} fields={["skills"]}>
        {skills === "failed" ? (
          <p className="settings-note">{t(lang, "doc.unreachable")}</p>
        ) : skills === null ? (
          <p className="settings-note">…</p>
        ) : skills.length === 0 ? (
          <p className="settings-note">{t(lang, "skset.empty")}</p>
        ) : (
          <InstalledShelf skills={skills} lang={lang} armed={armed} onSwitch={toggle} onRemove={remove} />
        )}
      </ReachBlock>
      {catalogue !== null && (
        <>
          <div className="settings-label" id={catalogueAnchorId}>
            {t(lang, "skset.catalogue")}
          </div>
          <p className="settings-note">{t(lang, "skset.catalogueNote")}</p>
          {catalogue.length === 0 ? (
            <p className="settings-note">{t(lang, "skset.catalogueEmpty")}</p>
          ) : (
            <CatalogueShelf catalogue={catalogue} lang={lang} reload={load} />
          )}
          {installMessage !== null && <p className="settings-error">{installMessage}</p>}
        </>
      )}
    </div>
  );
}

/**
 * The installed list, one group per namespace (card 411; owner, 2026-09-25:
 * "alle Skills, die ich installiert habe, möchte ich auch eingeklappt haben,
 * so wie unten die Pakete"). The groups and their counts come from the rows
 * of the latest `/api/skills` read on every render. The one thing held here
 * is which groups are open, and every group starts closed.
 */
export function InstalledShelf({
  skills,
  lang,
  armed,
  onSwitch,
  onRemove,
}: {
  skills: readonly InstalledSkill[];
  lang: Lang;
  /** The name whose remove button waits for its second press, or null. */
  armed: string | null;
  onSwitch: (row: InstalledSkill) => void;
  onRemove: (row: InstalledSkill) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The top level has no pack name, and a pack name is never empty.
  const keyOf = (group: InstalledNamespace): string => group.namespace ?? "";
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ul className="skset-packs skset-packs--installed">
      {installedGroups(skills).map((group) => (
        <InstalledGroup
          key={keyOf(group)}
          group={group}
          lang={lang}
          open={open.has(keyOf(group))}
          onToggleOpen={() => toggle(keyOf(group))}
          armed={armed}
          onSwitch={onSwitch}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

/**
 * One namespace of the installed list (card 411): a header with the count, and
 * the rows only while it is open. Each row carries its switch before its name
 * and its remove button right after its text. Hook-free, so a test can build
 * it, find its buttons and call their handlers.
 */
export function InstalledGroup({
  group,
  lang,
  open,
  onToggleOpen,
  armed,
  onSwitch,
  onRemove,
}: {
  group: InstalledNamespace;
  lang: Lang;
  open: boolean;
  onToggleOpen: () => void;
  armed: string | null;
  onSwitch: (row: InstalledSkill) => void;
  onRemove: (row: InstalledSkill) => void;
}) {
  return (
    <li className="skset-pack">
      <div className="skset-pack-head">
        <button type="button" className="skset-pack-toggle" aria-expanded={open} onClick={onToggleOpen}>
          <span className="skset-pack-caret" aria-hidden="true">
            ▸
          </span>
          {group.namespace === null ? (
            <span className="skset-pack-label">{t(lang, "skset.noNamespace")}</span>
          ) : (
            <span className="skset-name mono">{group.namespace}</span>
          )}
          <span className="skset-pack-count">{t(lang, "skset.installedCount", { count: group.count })}</span>
        </button>
      </div>
      {open && (
        <ul className="skset-list skset-pack-rows">
          {group.rows.map((row) => (
            <li key={`${row.source}:${row.name}`} className="skset-row">
              <button
                type="button"
                className={`thinking-toggle${row.disabled ? "" : " thinking-toggle--on"}`}
                role="switch"
                aria-checked={!row.disabled}
                aria-label={t(lang, "skset.enableLabel", { name: row.name })}
                title={t(lang, row.disabled ? "skset.enable" : "skset.disable")}
                onClick={() => onSwitch(row)}
              >
                <span className="thinking-toggle-track" aria-hidden="true">
                  <span className="thinking-toggle-knob" />
                </span>
              </button>
              <span className="skset-name mono">{row.name}</span>
              <span className="wsg-scope-tag">{row.source}</span>
              <span className="skset-desc" title={row.description}>
                {row.description}
              </span>
              {row.source === "user" && (
                <button
                  type="button"
                  className={`skset-del${armed === row.name ? " skset-del--armed" : ""}`}
                  aria-label={t(lang, armed === row.name ? "skset.deleteArmedLabel" : "skset.deleteLabel", {
                    name: row.name,
                  })}
                  title={t(lang, "skset.deleteTitle")}
                  onClick={() => onRemove(row)}
                >
                  {armed === row.name ? t(lang, "skset.deleteConfirm") : "✕"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The catalogue shelf as packs (card 410; owner, 2026-09-24: "dass wir die
 * einklappen und man kann die ausklappen und einzeln installieren, aber dass
 * wir einfach diese Skillsets mit einem Button installieren"). The groups and
 * their counts are computed from the rows of the latest `/api/skills` read on
 * every render. The one thing held here is which packs are open, and every
 * pack starts closed.
 */
export function CatalogueShelf({
  catalogue,
  lang,
  reload,
}: {
  catalogue: readonly CatalogueRow[];
  lang: Lang;
  /** Re-read `/api/skills`; the shelf's counts come back with the rows. */
  reload: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const { pending: installing } = useInstallState();
  const sets = usePackState();
  const removing = useRowRemoval();
  const busy = installing !== null || removing !== null || sets.pending !== null;
  const toggle = (pack: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(pack)) next.delete(pack);
      else next.add(pack);
      return next;
    });
  return (
    <ul className="skset-packs">
      {packGroups(catalogue).map((group) => (
        <CataloguePack
          key={group.pack}
          group={group}
          lang={lang}
          open={open.has(group.pack)}
          onToggle={() => toggle(group.pack)}
          busy={busy}
          pendingSet={sets.pending?.pack === group.pack ? sets.pending.action : null}
          installingId={installing}
          removingId={removing}
          refused={sets.refused?.pack === group.pack ? sets.refused : null}
          reload={reload}
        />
      ))}
    </ul>
  );
}

/** A refused skill's reason: the two refusals the shelf can name get a line of
 *  their own in both languages, anything else prints the server's sentence. */
function refusalReason(refusal: InstallRefusal, lang: Lang): string {
  if (refusal.status === 409 && refusal.root === "user") return t(lang, "skset.refusedTaken");
  if (refusal.status === 409 && refusal.root === "project") return t(lang, "skset.refusedProject");
  return refusal.reason;
}

/**
 * One pack of the shelf (card 410): a header with the count and the two set
 * buttons, and the pack's rows only while it is open. Hook-free, so a test can
 * build it, find its buttons and call their handlers.
 */
export function CataloguePack({
  group,
  lang,
  open,
  onToggle,
  busy,
  pendingSet,
  installingId,
  removingId,
  refused,
  reload,
}: {
  group: PackGroup;
  lang: Lang;
  open: boolean;
  onToggle: () => void;
  /** A copy, a set or a row's removal is running, in this pack or another: every press waits. */
  busy: boolean;
  /** This pack's own set button while it runs, for its label. */
  pendingSet: SetAction | null;
  /** The catalogue id a single install is copying, for that row's tooltip. */
  installingId: string | null;
  /** The catalogue id a row's off switch is removing, for that row's tooltip. */
  removingId: string | null;
  /** This pack's last refused set. */
  refused: PackRefusal | null;
  reload: () => void;
}) {
  return (
    <li className="skset-pack">
      <div className="skset-pack-head">
        <button type="button" className="skset-pack-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="skset-pack-caret" aria-hidden="true">
            ▸
          </span>
          <span className="skset-name mono">{group.pack}</span>
          <span className="skset-pack-count">
            {t(lang, "skset.packCount", { installed: group.installed, total: group.total })}
          </span>
        </button>
        {/* One group, so a narrow header moves both set buttons to the next
            line together instead of splitting them. */}
        <span className="skset-pack-sets">
          <button
            type="button"
            className="skset-install skset-pack-install"
            title={t(lang, "skset.packInstallTitle", { count: group.missing.length, pack: group.pack })}
            disabled={busy || group.missing.length === 0}
            onClick={() => void installSet(group.pack, group.missing, reload)}
          >
            {pendingSet === "install"
              ? t(lang, "skset.installing")
              : t(lang, "skset.packInstall", { count: group.missing.length })}
          </button>
          <button
            type="button"
            className="skset-del skset-pack-remove"
            title={t(lang, "skset.packRemoveTitle", { count: group.removable.length, pack: group.pack })}
            disabled={busy || group.removable.length === 0}
            onClick={() => void removeSet(group.pack, group.removable, reload)}
          >
            {pendingSet === "remove"
              ? t(lang, "skset.removing")
              : t(lang, "skset.packRemove", { count: group.removable.length })}
          </button>
        </span>
      </div>
      {refused !== null && (
        <div className="skset-pack-refused" role="alert">
          <p className="settings-error">
            {/* "Nothing was installed" holds only while the server took every
                copy back; a leftover gets its own line below instead. */}
            {refused.leftover !== undefined
              ? t(lang, "skset.setStopped", { count: refused.refused.length })
              : t(lang, refused.action === "install" ? "skset.setInstallRefused" : "skset.setRemoveRefused", {
                  count: refused.refused.length,
                })}
          </p>
          <ul className="skset-refused-list">
            {refused.refused.map((r) => (
              <li key={r.id} className="settings-error">
                <span className="mono">{r.id}</span>: {refusalReason(r, lang)}
              </li>
            ))}
          </ul>
          {refused.leftover !== undefined && (
            <>
              <p className="settings-error">
                {t(
                  lang,
                  refused.action === "install" ? "skset.setInstallLeftover" : "skset.setRemoveLeftover",
                )}
              </p>
              <ul className="skset-refused-list">
                {refused.leftover.map((id) => (
                  <li key={id} className="settings-error">
                    <span className="mono">{id}</span>
                  </li>
                ))}
              </ul>
              {refused.holding !== undefined && (
                <p className="settings-error">
                  {t(lang, "skset.setRemoveHolding", { path: refused.holding })}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {open && (
        <ul className="skset-list skset-pack-rows">
          {group.rows.map((row) => (
            <li key={row.id} className="skset-row">
              {/* On installs through the single install, off removes through
                  the single DELETE, the two paths the shelf and the installed
                  list already had. A project-root copy is the repo's, so its
                  switch shows on and does not move. Since card 411 the switch
                  stands before the name, and its accessible name is "install"
                  with the name the agent calls, so it differs from the same
                  skill's switch in the installed list. */}
              <button
                type="button"
                className={`thinking-toggle${row.installed ? " thinking-toggle--on" : ""}`}
                role="switch"
                aria-checked={row.installed}
                aria-label={t(lang, "skset.installLabel", { name: `${row.pack}:${row.name}` })}
                title={
                  installingId === row.id
                    ? t(lang, "skset.installing")
                    : removingId === row.id
                      ? t(lang, "skset.removing")
                      : row.root === "project"
                        ? t(lang, "skset.rowProjectTitle")
                        : row.installed
                          ? t(lang, "skset.rowRemoveTitle", { pack: row.pack })
                          : t(lang, "skset.installTitle", { pack: row.pack, licence: row.licence })
                }
                disabled={busy || row.root === "project"}
                onClick={() => {
                  if (row.installed) {
                    void removeSkill(row, reload);
                  } else {
                    void installSkill(row, reload);
                  }
                }}
              >
                <span className="thinking-toggle-track" aria-hidden="true">
                  <span className="thinking-toggle-knob" />
                </span>
              </button>
              <span className="skset-name mono">{row.name}</span>
              {/* The pack is not decoration: it is half the name the agent
                  calls, and the folder the copy lands in. */}
              <span className="wsg-scope-tag">{row.pack}</span>
              <span className="skset-desc" title={row.description}>
                {row.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function McpSettings({
  anchorId,
}: {
  /** The #/settings/mcp deep-link anchor (card 224) — the plus menu's
   *  "Manage MCP servers" lands here. */
  anchorId?: string;
} = {}) {
  const lang = useLang();
  const [servers, setServers] = useState<Record<string, unknown> | null | "failed">(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Card 220: the headless faces' opt-in — effective value, because the env
  // layer (SPECTRO_HEADLESS_MCP) can set it too and the switch must not show
  // "off" over a run that would mount. Null until the view arrives.
  const [headlessMcp, setHeadlessMcp] = useState<boolean | null>(null);

  const load = useCallback((): void => {
    fetchSettings()
      .then((view) => {
        const block = view.layers["user"]?.["mcpServers"];
        setServers(typeof block === "object" && block !== null ? (block as Record<string, unknown>) : {});
        setHeadlessMcp(view.effective["headlessMcp"] === true);
      })
      .catch(() => setServers("failed"));
  }, []);
  useEffect(load, [load]);

  const writeHeadless = (next: boolean): void => {
    putSettings("user", { headlessMcp: next })
      .then(() => {
        setError(null);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const write = (next: Record<string, unknown>): void => {
    putSettings("user", { mcpServers: next })
      .then(() => {
        setError(null);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const add = (): void => {
    if (servers === null || servers === "failed") return;
    const key = name.trim();
    const line = command.trim();
    if (key === "" || line === "") return;
    const [cmd, ...args] = line.split(/\s+/);
    write({ ...servers, [key]: args.length > 0 ? { command: cmd, args } : { command: cmd } });
    setName("");
    setCommand("");
  };

  const remove = (key: string): void => {
    if (servers === null || servers === "failed") return;
    const next = { ...servers };
    delete next[key];
    write(next);
  };

  // Card 224: the off switch the plus menu also renders. Off is written as an
  // explicit enabled:false INTO the entry rather than deleting it — the server
  // stays configured, its command stays readable here, and only the next agent
  // build skips it (McpServerRegistry never dials a disabled entry).
  const toggle = (key: string): void => {
    if (servers === null || servers === "failed") return;
    const entry = servers[key];
    if (typeof entry !== "object" || entry === null) return;
    const wasOn = (entry as Record<string, unknown>)["enabled"] !== false;
    write({ ...servers, [key]: { ...(entry as Record<string, unknown>), enabled: !wasOn } });
  };

  return (
    <div className="skset">
      <div className="settings-label" id={anchorId}>
        {t(lang, "mcpset.title")}
      </div>
      <p className="settings-note">{t(lang, "mcpset.note")}</p>
      {/* Card 222, review finding F10: this manager saved mcpServers with no
          reach sentence derived from anything — the intro above used to claim
          "apply to the next chat" in free text, which is the shape the whole
          module exists to remove. The claim is measured now:
          McpServerRegistry.load runs inside buildAgentOnce, off the
          session-scoped config, so a server added here is connected by the next
          session. */}
      <ReachBlock lang={lang} fields={["mcpServers"]}>
        {servers === "failed" ? (
          <p className="settings-note">{t(lang, "doc.unreachable")}</p>
        ) : servers === null ? (
          <p className="settings-note">…</p>
        ) : (
          <>
            {Object.keys(servers).length === 0 ? (
              <p className="settings-note">{t(lang, "mcpset.empty")}</p>
            ) : (
              <ul className="skset-list">
                {Object.entries(servers).map(([key, value]) => {
                  const entry =
                    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
                  const on = entry["enabled"] !== false;
                  return (
                    <li key={key} className="skset-row">
                      <button
                        type="button"
                        className={`thinking-toggle${on ? " thinking-toggle--on" : ""}`}
                        role="switch"
                        aria-checked={on}
                        title={t(lang, on ? "skset.disable" : "skset.enable")}
                        onClick={() => toggle(key)}
                      >
                        <span className="thinking-toggle-track" aria-hidden="true">
                          <span className="thinking-toggle-knob" />
                        </span>
                      </button>
                      <span className="skset-name mono">{key}</span>
                      {/* What this server RUNS, the way the reference shows
                          "npx -y tavily-mcp" — the raw JSON stays in the
                          tooltip as the full record. */}
                      <span className="skset-desc mono" title={JSON.stringify(value)}>
                        {mcpTarget(entry)}
                      </span>
                      <button
                        type="button"
                        className="skset-del"
                        title={t(lang, "mcpset.remove")}
                        onClick={() => remove(key)}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="skset-add">
              <input
                type="text"
                className="skset-input mono"
                value={name}
                placeholder={t(lang, "mcpset.namePh")}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                type="text"
                className="skset-input skset-input--wide mono"
                value={command}
                placeholder={t(lang, "mcpset.cmdPh")}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <button type="button" className="ghost" onClick={add}>
                {t(lang, "mcpset.add")}
              </button>
            </div>
            {error !== null && <p className="settings-error">{error}</p>}
          </>
        )}
      </ReachBlock>
      {/* Card 220: the headless opt-in lives in its OWN ReachBlock — its reach
          ("headless-run") is not the server list's ("next-session"), and one
          sentence about both is exactly what card 222 forbids. The switch
          mirrors the fx-switch markup the panel's Switch uses, so all four
          designs style it without a new class. */}
      <ReachBlock lang={lang} fields={["headlessMcp"]}>
        <div className="settings-toggles">
          <button
            type="button"
            className={`fx-switch${headlessMcp === true ? " fx-switch--on" : ""}`}
            role="switch"
            aria-checked={headlessMcp === true}
            disabled={headlessMcp === null || servers === "failed"}
            onClick={() => writeHeadless(!(headlessMcp === true))}
          >
            <span className="fx-switch-label">{t(lang, "mcpset.headlessLabel")}</span>
            <span className="fx-switch-track" aria-hidden="true">
              <span className="fx-switch-knob" />
            </span>
          </button>
        </div>
        <p className="settings-note">{t(lang, "mcpset.headlessNote")}</p>
      </ReachBlock>
    </div>
  );
}

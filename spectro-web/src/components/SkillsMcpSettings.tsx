// The settings page's skill + MCP managers (card 90). Skills: both roots
// listed (disabled ones included — the loader hides them, the manager must
// not), per-skill on/off via the .disabled marker, delete for user-root
// skills (two-step, the seeding ledger keeps them from returning). MCP: a
// friendly list over the USER scope's mcpServers block with add/remove —
// the composer gear's raw project-scope editor stays the escape hatch.
// Both managers say honestly that changes reach NEW sessions.

import { useCallback, useEffect, useState } from "react";
import { fetchSettings, putSettings } from "../state/serverSettings";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

interface SkillRow {
  name: string;
  description: string;
  source: "user" | "project";
  disabled: boolean;
}

/** An armed delete disarms after this long — the archive-delete pattern. */
const DELETE_ARM_TIMEOUT_MS = 4000;

export function SkillsSettings() {
  const lang = useLang();
  const [skills, setSkills] = useState<SkillRow[] | null | "failed">(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback((): void => {
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res) => setSkills((res as { skills: SkillRow[] }).skills))
      .catch(() => setSkills("failed"));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), DELETE_ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const toggle = (row: SkillRow): void => {
    fetch(`/api/skills/${encodeURIComponent(row.name)}/disabled`, {
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
    fetch(`/api/skills/${encodeURIComponent(row.name)}`, { method: "DELETE" })
      .then(load)
      .catch(load);
  };

  return (
    <div className="skset">
      <div className="settings-label">{t(lang, "skset.title")}</div>
      <p className="settings-note">{t(lang, "skset.note")}</p>
      {skills === "failed" ? (
        <p className="settings-note">{t(lang, "doc.unreachable")}</p>
      ) : skills === null ? (
        <p className="settings-note">…</p>
      ) : skills.length === 0 ? (
        <p className="settings-note">{t(lang, "skset.empty")}</p>
      ) : (
        <ul className="skset-list">
          {skills.map((row) => (
            <li key={`${row.source}:${row.name}`} className="skset-row">
              <button
                type="button"
                className={`thinking-toggle${row.disabled ? "" : " thinking-toggle--on"}`}
                role="switch"
                aria-checked={!row.disabled}
                title={t(lang, row.disabled ? "skset.enable" : "skset.disable")}
                onClick={() => toggle(row)}
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
                  title={t(lang, "skset.deleteTitle")}
                  onClick={() => remove(row)}
                >
                  {armed === row.name ? t(lang, "skset.deleteConfirm") : "✕"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function McpSettings() {
  const lang = useLang();
  const [servers, setServers] = useState<Record<string, unknown> | null | "failed">(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    fetchSettings()
      .then((view) => {
        const block = view.layers["user"]?.["mcpServers"];
        setServers(typeof block === "object" && block !== null ? (block as Record<string, unknown>) : {});
      })
      .catch(() => setServers("failed"));
  }, []);
  useEffect(load, [load]);

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

  return (
    <div className="skset">
      <div className="settings-label">{t(lang, "mcpset.title")}</div>
      <p className="settings-note">{t(lang, "mcpset.note")}</p>
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
              {Object.entries(servers).map(([key, value]) => (
                <li key={key} className="skset-row">
                  <span className="skset-name mono">{key}</span>
                  <span className="skset-desc mono" title={JSON.stringify(value)}>
                    {JSON.stringify(value)}
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
              ))}
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
    </div>
  );
}

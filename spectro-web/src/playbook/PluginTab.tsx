// Card 526: the Plugin tab of the playbook pane. It lists the Claude Code
// plugins the server found in this home, each with its labels, a checkbox per
// kind it carries and an Import button. The server maps each kind onto the
// playbook's format and names what it leaves out; PluginReport shows that
// answer word for word under the toolbar, also on the Skills tab the pane
// turns to after an import.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { reasonText } from "../state/bundleEditor";
import { useLang } from "../state/lang";
import {
  closeReport,
  importPlugin,
  loadPluginSources,
  PLUGIN_KINDS,
  pluginKey,
  usePluginImport,
  type PluginKind,
  type PluginRow,
} from "../state/pluginImport";

const KIND_LABEL: Record<PluginKind, string> = {
  skills: "pbp.kind.skills",
  agents: "pbp.kind.agents",
  commands: "pbp.kind.commands",
  hooks: "pbp.kind.hooks",
};

/** Why an agent field or a command was left out, by the server's reason code. */
const DROPPED_WHY: Record<string, string> = {
  "set-by-others": "pbp.why.setByOthers",
  refused: "pbp.why.refused",
  "not-a-playbook-field": "pbp.why.notAField",
  type: "pbp.why.type",
  nested: "pbp.why.nested",
};

/** Why a hook was left out, by the server's reason code. */
const HOOK_WHY: Record<string, string> = {
  event: "pbp.why.event",
  type: "pbp.why.hookType",
  "plugin-root": "pbp.why.pluginRoot",
};

/**
 * One plugin: its labels, a checkbox per kind it carries, and Import.
 *
 * @param props.row       the plugin as listed
 * @param props.dir       the folder shown
 * @param props.workspace the workspace of the pane
 */
export function PluginRowView({
  row,
  dir,
  workspace,
}: {
  row: PluginRow;
  dir: string;
  workspace: string | null;
}) {
  const lang = useLang();
  const s = usePluginImport();
  const [ticked, setTicked] = useState<ReadonlySet<PluginKind>>(new Set());
  const key = pluginKey(row);
  const toggle = (kind: PluginKind): void => {
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };
  return (
    <li className="pbp-row" data-plugin={key}>
      <div className="pbp-head">
        <span className="pbp-name">{row.name}</span>
        {row.version !== "" && <span className="pbp-version pb-mono">{row.version}</span>}
        <span className="pbp-where">
          {t(lang, row.root === "cache" ? "pbp.root.cache" : "pbp.root.marketplace", {
            marketplace: row.marketplace,
          })}
        </span>
      </div>
      {row.description !== "" && <p className="pbb-pick-description">{row.description}</p>}
      <div className="pbp-kinds">
        {PLUGIN_KINDS.map((kind) => (
          <label key={kind} className="pbp-kind">
            <input
              type="checkbox"
              checked={ticked.has(kind)}
              disabled={row.kinds[kind] === 0 || !row.licensed}
              data-kind={`${key}#${kind}`}
              onChange={() => toggle(kind)}
            />
            <span>{t(lang, KIND_LABEL[kind], { count: row.kinds[kind] })}</span>
          </label>
        ))}
      </div>
      {row.mcp && <p className="pbb-note pbp-mcp">{t(lang, "pbp.mcp")}</p>}
      {!row.licensed && <p className="pbb-note pbp-unlicensed">{t(lang, "pbp.unlicensed")}</p>}
      <div className="pbb-panel-actions">
        <button
          type="button"
          className="pbp-go"
          data-plugin={key}
          disabled={ticked.size === 0 || s.busy || !row.licensed}
          onClick={() =>
            void importPlugin(
              dir,
              workspace,
              row,
              PLUGIN_KINDS.filter((k) => ticked.has(k)),
            )
          }
        >
          {t(lang, "pbp.go")}
        </button>
      </div>
    </li>
  );
}

/**
 * The Plugin tab: the plugins of this home, or a sentence that there are none.
 *
 * @param props.dir       the folder shown
 * @param props.workspace the workspace of the pane
 */
export function PluginTab({ dir, workspace }: { dir: string; workspace: string | null }) {
  const lang = useLang();
  const s = usePluginImport();
  useEffect(() => {
    void loadPluginSources(dir);
  }, [dir]);
  const rows = s.dir === dir ? s.rows : null;
  return (
    <div className="pbp-tab">
      <p className="pbb-note pbb-hint">{t(lang, "pbp.hint")}</p>
      {s.error !== null && (
        <p className="pbb-refusal" role="alert">
          {reasonText(lang, s.error.reason, s.error.message)}
        </p>
      )}
      {rows === null ? (
        <p className="pbb-note">{t(lang, "pbp.reading")}</p>
      ) : rows.length === 0 ? (
        <p className="pbb-note pbp-none">{t(lang, "pbp.none")}</p>
      ) : (
        <ul className="pbp-list" aria-label={t(lang, "pbp.tab")}>
          {rows.map((row) => (
            <PluginRowView key={pluginKey(row)} row={row} dir={dir} workspace={workspace} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Paths({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="pbp-report-part">
      <h4 className="pbb-group">{title}</h4>
      <ul className="pbp-report-list">
        {paths.map((p) => (
          <li key={p}>
            <code className="pb-mono">{p}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the last import into the folder copied, found there already and left
 * out, as the server answered it.
 *
 * @param props.dir the folder shown; a report of another folder is not drawn
 */
export function PluginReport({ dir }: { dir: string }) {
  const lang = useLang();
  const s = usePluginImport();
  const r = s.report;
  if (r === null || r.dir !== dir) return null;
  const copied = [
    ...r.imported.skills,
    ...r.imported.agents,
    ...r.imported.commands,
    ...r.imported.hooks,
    ...r.imported.scripts,
  ];
  return (
    <section className="pbp-report" aria-label={t(lang, "pbp.report.title", { plugin: r.plugin })}>
      <div className="pbp-report-head">
        <h3 className="pb-h">{t(lang, "pbp.report.title", { plugin: r.plugin })}</h3>
        <button type="button" className="pbp-close" onClick={closeReport}>
          {t(lang, "pbp.report.close")}
        </button>
      </div>
      {copied.length === 0 && <p className="pbb-note">{t(lang, "pbp.report.nothing")}</p>}
      <Paths title={t(lang, "pbp.report.copied")} paths={copied} />
      <Paths title={t(lang, "pbp.report.already")} paths={r.already} />
      {r.dropped.length > 0 && (
        <div className="pbp-report-part">
          <h4 className="pbb-group">{t(lang, "pbp.report.dropped")}</h4>
          <ul className="pbp-report-list">
            {r.dropped.map((d, i) => (
              <li key={`${d.path}#${d.field ?? ""}#${i}`}>
                <code className="pb-mono">{d.path}</code>
                {d.field !== null && (
                  <>
                    {" "}
                    <code className="pb-mono pbp-field">{d.field}</code>
                  </>
                )}{" "}
                <span className="pbp-why">
                  {DROPPED_WHY[d.reason] !== undefined ? t(lang, DROPPED_WHY[d.reason]) : d.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.droppedHooks.length > 0 && (
        <div className="pbp-report-part">
          <h4 className="pbb-group">{t(lang, "pbp.report.droppedHooks")}</h4>
          <ul className="pbp-report-list">
            {r.droppedHooks.map((h, i) => (
              <li key={`${h.event}#${i}`}>
                <code className="pb-mono pbp-event">{h.event}</code>{" "}
                <code className="pb-mono">{h.matcher ?? "*"}</code>
                {h.command !== null && (
                  <>
                    {" "}
                    <code className="pb-mono pbb-hook-command">{h.command}</code>
                  </>
                )}{" "}
                <span className="pbp-why">
                  {HOOK_WHY[h.reason] !== undefined ? t(lang, HOOK_WHY[h.reason]) : h.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Paths title={t(lang, "pbp.report.notCopied")} paths={r.notCopied} />
    </section>
  );
}

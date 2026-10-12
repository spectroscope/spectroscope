// Card 524: the import of a playbook bundle and the answer of an export,
// drawn under the folder picker of the playbook pane until card 525 gives the
// pane a toolbar. The preview lists the files and the contents the bundle's
// playbook.json declares; the import button opens the folder chooser and
// writes into the folder picked. A refusal of the server is shown word for
// word, with its findings.

import { t } from "../i18n/i18n";
import { chooseFolder, usePickNote } from "../state/folderPick";
import { useLang } from "../state/lang";
import { clearBundle, importBundleInto, useBundleState, type ServerRefusal } from "../state/playbookBundle";

/** The contents kinds in the order the list shows them. */
const KINDS = ["skills", "agents", "hooks", "commands", "workflows"] as const;

/** A finding of a credential refusal: the file and line from its path, the rule from its message. */
const TOKEN_PATH = /^(.*):(\d+)$/;
const TOKEN_RULE = /pattern (\S+)$/;

/**
 * A credential in a hook command (card 538), told in the language of the page: the file, then
 * one line per hit with its line number and the pattern. The value never reaches the browser.
 */
function TokenRefusal({
  refusal,
  cls,
  done,
}: {
  refusal: ServerRefusal;
  cls: string;
  done: "export" | "import";
}) {
  const lang = useLang();
  const hits = refusal.findings.map((f) => ({
    at: TOKEN_PATH.exec(f.path),
    rule: TOKEN_RULE.exec(f.message),
  }));
  const file = hits[0]?.at?.[1] ?? "hooks/hooks.json";
  return (
    <div className={cls} role="alert">
      <p className="pb-notice">
        {t(lang, done === "export" ? "pb.bundle.tokenExport" : "pb.bundle.tokenImport", { file })}
      </p>
      <ul className="pb-findings">
        {hits.map((h, i) => (
          <li className="pb-finding" key={`${h.at?.[2] ?? ""}#${i}`}>
            {t(lang, "pb.bundle.tokenLine", { line: h.at?.[2] ?? "?", rule: h.rule?.[1] ?? "?" })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Refusal({ refusal, cls, done }: { refusal: ServerRefusal; cls: string; done: "export" | "import" }) {
  if (refusal.reason === "token") {
    return <TokenRefusal refusal={refusal} cls={cls} done={done} />;
  }
  return (
    <div className={cls} role="alert">
      <p className="pb-notice">{refusal.message}</p>
      {refusal.findings.length > 0 && (
        <ul className="pb-findings">
          {refusal.findings.map((f, i) => (
            <li className="pb-finding" key={`${f.path}#${i}`}>
              <code className="pb-mono">{f.path}</code> {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * @param props.workspace  the workspace the loaded view resolves skills against
 * @param props.onImported called with the folder the server wrote, to show it
 */
export function BundleImport({
  workspace,
  onImported,
}: {
  workspace: string | null;
  onImported: (dir: string) => void;
}) {
  const lang = useLang();
  const bundle = useBundleState();
  const pickNote = usePickNote("pbImport");
  const preview = bundle.preview;

  const pick = (): void => {
    void chooseFolder("pbImport", (dir) => {
      void importBundleInto(dir, workspace).then((written) => {
        if (written !== null) onImported(written);
      });
    });
  };

  return (
    <>
      {bundle.exportRefusal !== null && (
        <Refusal refusal={bundle.exportRefusal} cls="pb-bundle-export-refusal" done="export" />
      )}
      {bundle.busy && preview === null && (
        <p className="pb-notice" role="status">
          {t(lang, "pb.bundle.reading")}
        </p>
      )}
      {bundle.refusal !== null && (
        <p className="pb-notice pb-bundle-refusal" role="alert">
          {t(lang, bundle.refusal.key, bundle.refusal.vars)}
        </p>
      )}
      {bundle.imported !== null && (
        <p className="pb-notice pb-bundle-done" role="status">
          {t(lang, "pb.bundle.done", { dir: bundle.imported })}
        </p>
      )}
      {preview !== null && (
        <section className="pb-bundle" aria-label={t(lang, "pb.bundle.title")}>
          <h3 className="pb-h">{t(lang, "pb.bundle.title")}</h3>
          <p className="pb-bundle-summary">
            {t(lang, "pb.bundle.summary", { name: preview.name, id: preview.id, n: preview.entries.length })}
          </p>
          <p className="pb-bundle-hint">{t(lang, "pb.bundle.hint")}</p>
          <h4 className="pb-bundle-h">{t(lang, "pb.bundle.contents")}</h4>
          {KINDS.every((k) => preview.contents[k].length === 0) ? (
            <p className="pb-bundle-hint">{t(lang, "pb.bundle.noContents")}</p>
          ) : (
            <ul className="pb-bundle-contents">
              {KINDS.filter((k) => preview.contents[k].length > 0).map((k) => (
                <li key={k}>
                  <span className="pb-bundle-kind">{k}</span>{" "}
                  <code className="pb-mono">{preview.contents[k].join(", ")}</code>
                </li>
              ))}
            </ul>
          )}
          <h4 className="pb-bundle-h">{t(lang, "pb.bundle.files")}</h4>
          <ul className="pb-bundle-files">
            {preview.entries.map((e) => (
              <li key={e.path} className="pb-mono">
                {e.path}
              </li>
            ))}
          </ul>
          <div className="pb-bundle-actions">
            <button type="button" className="pb-bundle-pick" disabled={bundle.busy} onClick={pick}>
              {t(lang, "pb.bundle.pick")}
            </button>
            <button type="button" className="pb-bundle-cancel" disabled={bundle.busy} onClick={clearBundle}>
              {t(lang, "pb.bundle.cancel")}
            </button>
          </div>
          {pickNote !== null && (
            <p className="pb-notice" role="status">
              {pickNote}
            </p>
          )}
          {bundle.server !== null && <Refusal refusal={bundle.server} cls="pb-bundle-server" done="import" />}
        </section>
      )}
    </>
  );
}

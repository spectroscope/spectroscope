// The provider overview on the settings page (playbook concept, P1; owner
// decision D10, 2026-10-09): every provider the config knows, its state in
// words, key presence as a word, the address a local one dials, the model
// count, the age of the last check, and a Check button. Checks run only on a
// press, on mount for the local kind, and once after a key save. No timer.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  checkProviders,
  refreshProviders,
  useProviderRows,
  type ProviderRow,
  type ProviderState,
} from "../state/providerRegistry";
import { providerDisplayName } from "./providerPickerMode";

export function stateLabelKey(state: ProviderState): string {
  return `prov.state.${state}`;
}

export function ageLabel(checkedAt: number, now: number, lang: Lang): string {
  if (checkedAt <= 0) return t(lang, "prov.never");
  const s = Math.max(0, Math.round((now - checkedAt) / 1000));
  return t(lang, "prov.ago", { s });
}

/** The server never checks the built-in provider or a provider that lacks its
 *  key or its model file, so those rows get no button. */
function checkable(row: ProviderRow): boolean {
  return (
    row.kind !== "builtin" &&
    row.state !== "needs-key" &&
    row.state !== "needs-signin" &&
    row.state !== "needs-download"
  );
}

function Row({ row, busy, onCheck }: { row: ProviderRow; busy: boolean; onCheck: () => void }) {
  const lang = useLang();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [row.checkedAt]);
  return (
    <tr className={`prov-row prov-row--${row.state}`}>
      <td className="mono">{providerDisplayName(row.id)}</td>
      <td className="prov-state">
        {t(lang, stateLabelKey(row.state))}
        {row.reason && <span className="provider-field-note"> ({row.reason})</span>}
      </td>
      <td>{row.kind === "cloud" ? t(lang, row.keyPresent ? "prov.keyYes" : "prov.keyNo") : ""}</td>
      <td className="mono prov-address">{row.endpoint ?? ""}</td>
      <td>
        {row.state === "reachable"
          ? t(lang, row.live ? "prov.models" : "prov.modelsFallback", { n: row.models.length })
          : ""}
      </td>
      <td className="prov-age">{ageLabel(row.checkedAt, now, lang)}</td>
      <td className="prov-action">
        {checkable(row) && (
          <button type="button" className="prov-check-one ghost" disabled={busy} onClick={onCheck}>
            {t(lang, "prov.check")}
          </button>
        )}
      </td>
    </tr>
  );
}

export function ProviderStatusSettings({ anchorId }: { anchorId: string }) {
  const lang = useLang();
  const rows = useProviderRows();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshProviders().then(() => checkProviders("local"));
  }, []);

  const run = (target: string): void => {
    setBusy(true);
    void checkProviders(target).finally(() => setBusy(false));
  };

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "prov.title")}
      </div>
      <p className="settings-note">{t(lang, "prov.hint")}</p>
      <div className="prov-scroll">
        <table className="prov-table">
          <thead>
            <tr>
              <th>{t(lang, "prov.col.provider")}</th>
              <th>{t(lang, "prov.col.state")}</th>
              <th>{t(lang, "prov.col.key")}</th>
              <th>{t(lang, "prov.col.address")}</th>
              <th>{t(lang, "prov.col.models")}</th>
              <th>{t(lang, "prov.col.checked")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} row={row} busy={busy} onCheck={() => run(row.id)} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="prov-foot">
        <button
          type="button"
          className="prov-check-all soft-primary"
          disabled={busy}
          onClick={() => run("all")}
        >
          {t(lang, "prov.checkAll")}
        </button>
      </div>
    </>
  );
}

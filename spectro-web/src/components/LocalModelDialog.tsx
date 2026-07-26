// The chooser behind the built-in provider. It opens when you pick "built-in"
// and shows every model this build offers: what each is good for, whether the
// agent can use tools with it, how heavy it is, and whether THIS machine can
// hold it (the server measures memory and disk). Downloads stream progress per
// model; nothing downloads without the explicit click — this dialog IS the
// permission gate. On a ready model, "use" hands the id back to the picker.

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  fetchLocalCatalog,
  fetchLocalModelStatus,
  startLocalModelDownload,
  progressPct,
  formatGB,
  fitKey,
  type Catalog,
  type CatalogModel,
} from "../state/localModel";

export function LocalModelDialog({
  onUse,
  onClose,
}: {
  /** A model is ready and picked — switch the provider to it. */
  onUse: (modelId: string) => void;
  /** Dismissed — the picker keeps whatever it had. */
  onClose: () => void;
}) {
  const lang = useLang();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [sel, setSel] = useState<string>("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // One fetch fills the whole dialog; the default model starts selected.
  useEffect(() => {
    let alive = true;
    void fetchLocalCatalog().then(
      (c) => {
        if (!alive) return;
        setCatalog(c);
        setSel((s) => s || c.defaultId);
        const running = c.models.find((m) => m.state === "downloading");
        if (running) setDownloading(running.id);
      },
      () => {
        /* the dialog shows its loading row until a retry succeeds */
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Poll the running download; on ready/failed refresh the catalogue rows.
  useEffect(() => {
    if (!downloading) return;
    const tick = async (): Promise<void> => {
      try {
        const s = await fetchLocalModelStatus(downloading);
        setProgress({ bytes: s.bytes, total: s.total });
        if (s.state === "ready" || s.state === "failed") {
          setDownloading(null);
          setProgress(null);
          setError(s.state === "failed" ? (s.error ?? "download failed") : null);
          setCatalog(await fetchLocalCatalog());
        }
      } catch {
        /* transient — keep polling */
      }
    };
    timer.current = window.setInterval(() => void tick(), 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [downloading]);

  const download = async (id: string): Promise<void> => {
    setError(null);
    setDownloading(id);
    setProgress(null);
    try {
      await startLocalModelDownload(id);
    } catch {
      setDownloading(null);
    }
  };

  const selected: CatalogModel | undefined = catalog?.models.find((m) => m.id === sel);
  const busy = downloading !== null;

  const rowFit = (m: CatalogModel): { key: string; blocked: boolean } => {
    const key = fitKey(m);
    return { key, blocked: key === "lm.fit.ram" || key === "lm.fit.disk" };
  };

  return (
    <div className="modal-backdrop">
      <div className="modal lm-modal" role="dialog" aria-modal="true" aria-labelledby="lm-title">
        <div className="modal-head">
          <span className="eyebrow sand">{t(lang, "lm.eyebrow")}</span>
        </div>
        <h2 id="lm-title">{t(lang, "lm.title")}</h2>
        <p className="import-hint">{t(lang, "lm.intro")}</p>

        {!catalog && <p className="import-hint">{t(lang, "lm.loading")}</p>}

        {catalog && (
          <ul className="lm-list" role="radiogroup" aria-label={t(lang, "lm.title")}>
            {catalog.models.map((m) => {
              const fit = rowFit(m);
              const isSel = m.id === sel;
              const isDownloading = downloading === m.id;
              const pct =
                isDownloading && progress ? progressPct(progress.bytes, progress.total || m.sizeBytes) : 0;
              return (
                <li key={m.id} className={`lm-row${isSel ? " sel" : ""}`}>
                  <label className="lm-row-main">
                    <input type="radio" name="lm-model" checked={isSel} onChange={() => setSel(m.id)} />
                    <span className="lm-row-name">
                      <b>{m.label}</b>
                      {m.id === catalog.defaultId && (
                        <span className="lm-badge lm-default">{t(lang, "lm.default")}</span>
                      )}
                      <span className="lm-goodfor">{t(lang, `local.model.${m.id}.goodFor`)}</span>
                    </span>
                    <span className="lm-row-meta mono">
                      {formatGB(m.sizeBytes)}
                      <span className={`lm-badge ${m.nativeTools ? "ok" : "warn"}`}>
                        {t(lang, m.nativeTools ? "lm.toolsYes" : "lm.toolsNo")}
                      </span>
                      {m.reasoning && <span className="lm-badge think">{t(lang, "lm.thinkYes")}</span>}
                      {m.state === "ready" && <span className="lm-badge ok">{t(lang, "lm.ready")}</span>}
                    </span>
                  </label>
                  <span className={`lm-fit${fit.blocked ? " blocked" : ""}`}>{t(lang, fit.key)}</span>
                  {isSel && (
                    <div className="lm-detail">
                      <p>{t(lang, `local.model.${m.id}.blurb`)}</p>
                      {m.licenceCaveat && (
                        <p className="lm-caveat">{t(lang, `local.model.${m.id}.licenceCaveat`)}</p>
                      )}
                      <p className="lm-links mono">
                        {t(lang, "lm.licence")}:{" "}
                        <a href={m.licenceUrl} target="_blank" rel="noreferrer">
                          {m.licence}
                        </a>
                        {" · "}
                        <a href={m.sourceUrl} target="_blank" rel="noreferrer">
                          {t(lang, "lm.source")}
                        </a>
                      </p>
                    </div>
                  )}
                  {isDownloading && (
                    <div className="lm-progress" aria-live="polite">
                      <div className="lm-progress-track">
                        <div className="lm-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="mono">
                        {pct}% · {formatGB(progress?.bytes ?? 0)} / {formatGB(progress?.total || m.sizeBytes)}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p className="lm-error" role="alert">
            {t(lang, "lm.failed")}: {error}
          </p>
        )}

        <div className="modal-foot lm-foot">
          <button type="button" className="ghost" onClick={onClose}>
            {t(lang, "lm.close")}
          </button>
          {selected && selected.state === "ready" ? (
            <button type="button" className="primary" onClick={() => onUse(selected.id)}>
              {t(lang, "lm.use", { model: selected.label })}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!selected || busy || rowFit(selected).blocked}
              onClick={() => selected && void download(selected.id)}
            >
              {busy
                ? t(lang, "lm.downloading")
                : selected
                  ? t(lang, "lm.download", { size: formatGB(selected.sizeBytes) })
                  : "…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

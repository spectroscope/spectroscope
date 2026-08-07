// Speech to text, as a pane a DMG user can actually act on (card 184 leg 2b,
// owner: "mache das init-stt auch in der UI verfügbar. sonst Bruch mit DMG UI
// only").
//
// The honest line runs through the middle of this pane and is the whole design.
// `scripts/setup-stt.sh` does two things:
//
//   the MODEL is a sha-pinned download, and a button can really do that;
//   the BINARIES it installs through brew or apt, which this app must not drive
//   and a DMG user has no terminal for.
//
// So the model half gets a button, and the binary half gets its path when it is
// there and one true install line when it is not. Never a button that cannot
// keep its promise — the answer card 100 already reached for llama-server.

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatBytes } from "../workspace/preview";

interface BinaryState {
  found: boolean;
  path: string | null;
}

interface SttStatus {
  model: { file: string; path: string; present: boolean; bytes: number; expectedBytes: number };
  binaries: Record<string, BinaryState>;
  ready: boolean;
  binaryHint: string | null;
  download: { state?: string; bytes?: number; total?: number; error?: string | null };
}

export function SttSettings({ anchorId }: { anchorId: string }) {
  const lang = useLang();
  const [status, setStatus] = useState<SttStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/stt/status");
      setStatus(res.ok ? ((await res.json()) as SttStatus) : null);
    } catch {
      setStatus(null); // an older server has no such endpoint; the pane says nothing
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a download runs, the state is worth re-reading — and only then, so an
  // idle settings page is not polling a server for news it will never have.
  const state = status?.download?.state ?? "absent";
  useEffect(() => {
    if (state !== "downloading") return;
    const id = setInterval(() => void load(), 1000);
    return () => clearInterval(id);
  }, [state, load]);

  if (status === null) return null;

  const model = status.model;
  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch("/api/stt/model/download", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secStt")}
      </div>
      <p className="settings-note">{t(lang, "set.sttHint")}</p>
      <dl className="ed-rows">
        <div>
          <dt className="mono">{model.file}</dt>
          <dd className="mono">
            {model.present
              ? `${t(lang, "set.sttPresent")} · ${formatBytes(model.bytes)}`
              : `${t(lang, "set.sttAbsent")} · ${formatBytes(model.expectedBytes)}`}
          </dd>
        </div>
        {Object.entries(status.binaries).map(([name, bin]) => (
          <div key={name}>
            <dt className="mono">{name}</dt>
            {/* The path is the proof. "found" without one would be a claim. */}
            <dd className="mono">{bin.found ? bin.path : t(lang, "set.sttMissing")}</dd>
          </div>
        ))}
      </dl>
      {!model.present && (
        <p className="settings-note">
          <button
            type="button"
            className="trace-source-more"
            disabled={busy || state === "downloading"}
            onClick={() => void start()}
          >
            {state === "downloading"
              ? t(lang, "set.sttDownloading", {
                  done: formatBytes(status.download.bytes ?? 0),
                  total: formatBytes(model.expectedBytes),
                })
              : t(lang, "set.sttDownload", { size: formatBytes(model.expectedBytes) })}
          </button>
        </p>
      )}
      {status.download?.error ? <p className="settings-note">{status.download.error}</p> : null}
      {/* A sentence, not a button: this app does not run a package manager. */}
      {status.binaryHint !== null && (
        <p className="settings-note">
          {t(lang, "set.sttBinaryHint")} <code className="mono">{status.binaryHint}</code>
        </p>
      )}
      <p className="settings-note">{status.ready ? t(lang, "set.sttReady") : t(lang, "set.sttNotReady")}</p>
    </>
  );
}

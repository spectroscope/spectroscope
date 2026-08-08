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
  /** The LOCAL route's readiness — model and binary both here. */
  ready: boolean;
  binaryHint: string | null;
  download: { state?: string; bytes?: number; total?: number; error?: string | null };
  /** The setting as configured: "auto" | "local" | "openai". */
  provider?: string;
  /** What a recording would do right now: "local" | "hosted". */
  route?: string;
  hosted?: { keyPresent: boolean; keyEnv: string; model: string };
  /** Whether the route being taken can actually run. */
  speechWorks?: boolean;
}

/** The values `sttProvider` accepts, in the order the pane offers them. */
const STT_PROVIDERS = ["auto", "local", "openai"] as const;

export function SttSettings({
  anchorId,
  onSave,
}: {
  anchorId: string;
  /** Writes one settings key, exactly like every other field in this panel. */
  onSave?: (patch: Record<string, unknown>) => void;
}) {
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
      {/* Which way speech goes. The hosted one needs a key and nothing else,
          which is what makes voice work in a DMG; the local one sends nothing
          out, which is the reason it stays. */}
      {status.route !== undefined && (
        <label className="settings-field">
          <span>{t(lang, "set.sttProvider")}</span>
          <select
            value={String(status.provider ?? "auto")}
            onChange={(e) => {
              onSave?.({ sttProvider: e.target.value });
              // The pane describes the server's answer, so re-ask rather than
              // guess what the write did.
              window.setTimeout(() => void load(), 150);
            }}
            disabled={onSave === undefined}
          >
            {STT_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(lang, `set.sttProvider.${p}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {status.hosted !== undefined && (
        <p className="settings-note">
          {status.hosted.keyPresent
            ? t(lang, "set.sttHostedReady", { model: status.hosted.model })
            : t(lang, "set.sttHostedNoKey", { key: status.hosted.keyEnv })}
        </p>
      )}
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
      {/* The summary answers the question a reader has — "does speech work" —
          which depends on the ROUTE. Saying "not installed" to somebody whose
          recordings go to the hosted provider would describe a path this
          machine is not taking. */}
      <p className="settings-note">
        {(status.speechWorks ?? status.ready)
          ? status.route === "hosted"
            ? t(lang, "set.sttReadyHosted")
            : t(lang, "set.sttReady")
          : t(lang, "set.sttNotReady")}
      </p>
    </>
  );
}

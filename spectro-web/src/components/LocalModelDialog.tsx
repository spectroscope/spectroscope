// The download modal behind the built-in provider. It opens when you pick
// "built-in · VibeThinker-3B" and the model isn't there yet (the lean build).
// It offers the download, streams progress from the server, and on completion
// hands control back so the provider switch can proceed. Nothing downloads
// without the explicit Download click — this modal IS the permission gate.

import { useEffect, useRef, useState } from "react";
import {
  LOCAL_MODEL_NAME,
  LOCAL_MODEL_SIZE,
  formatGB,
  progressPct,
  fetchLocalModelStatus,
  startLocalModelDownload,
  type LocalModelStatus,
} from "../state/localModel";

export function LocalModelDialog({
  onReady,
  onClose,
}: {
  /** The download finished and verified — proceed with selecting the provider. */
  onReady: () => void;
  /** Dismissed without a ready model — the picker keeps 'needs download'. */
  onClose: () => void;
}) {
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const state = status?.state ?? "absent";
  const pct = status ? progressPct(status.bytes, status.total || LOCAL_MODEL_SIZE) : 0;

  // Once ready, hand control back.
  useEffect(() => {
    if (state === "ready") onReady();
  }, [state, onReady]);

  // Poll while downloading.
  useEffect(() => {
    if (!busy) return;
    const tick = async (): Promise<void> => {
      try {
        const s = await fetchLocalModelStatus();
        setStatus(s);
        if (s.state === "ready" || s.state === "failed") {
          setBusy(false);
          return;
        }
      } catch {
        /* transient — keep polling */
      }
    };
    timer.current = window.setInterval(() => void tick(), 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [busy]);

  const download = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await startLocalModelDownload());
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal lm-modal" role="dialog" aria-modal="true" aria-labelledby="lm-title">
        <div className="modal-head">
          <span className="eyebrow sand">built-in model</span>
        </div>
        <h2 id="lm-title">Download {LOCAL_MODEL_NAME}?</h2>
        <p className="import-hint">
          A small reasoning model that runs entirely on your machine — no API key, no LM Studio, no Ollama.
          Great for chat, reasoning and the explain lens; for tool-agent work, use a key or a tool-capable
          model. One download of about {formatGB(LOCAL_MODEL_SIZE)}, then it works offline forever.
        </p>

        {state === "downloading" && (
          <div className="lm-progress" aria-live="polite">
            <div className="lm-progress-track">
              <div className="lm-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="mono">
              {pct}% · {formatGB(status?.bytes ?? 0)} / {formatGB(status?.total || LOCAL_MODEL_SIZE)}
            </span>
          </div>
        )}

        {state === "failed" && (
          <p className="lm-error" role="alert">
            Download failed{status?.error ? `: ${status.error}` : ""}. You can try again.
          </p>
        )}

        <div className="modal-foot lm-foot">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void download()} disabled={busy}>
            {state === "failed" ? "Retry" : busy ? "Downloading…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}

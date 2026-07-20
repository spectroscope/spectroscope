// Session import: paste or pick a .jsonl — raw spectroscope RunEvents replay
// verbatim, real Claude Code transcripts run through the adapter. The loaded
// stream feeds the SAME replay path as a stored session, so every tab (chat,
// graph, flow, lab, trace) renders it with zero extra plumbing.
//
// Because ~/.claude is invisible in Finder (a file chooser cannot even get
// there), the dialog also lists the transcripts the server finds under
// ~/.claude/projects — one click imports straight from the store.

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { RunEvent } from "../events";
import { detectAndLoad } from "../import/detect";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { relativeTime } from "../format";

interface TranscriptInfo {
  path: string;
  project: string;
  file: string;
  size: number;
  modifiedAt: number;
}

function formatKb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export function ImportDialog(props: {
  onLoad: (events: RunEvent[], label: string, kind: "spectroscope" | "claude-code") => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const lang = useLang();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/claude/transcripts")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (alive && Array.isArray(list)) setTranscripts(list as TranscriptInfo[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const load = (raw: string, label: string): void => {
    try {
      const { events, kind } = detectAndLoad(raw);
      props.onLoad(events, label, kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadFromStore = (tr: TranscriptInfo): void => {
    setError(null);
    fetch(`/api/claude/transcripts/content?path=${encodeURIComponent(tr.path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((raw) => load(raw, tr.file))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then((raw) => load(raw, file.name));
  };

  return (
    <div className="modal-backdrop">
      <div className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-head">
          <span className="eyebrow sand">Import</span>
        </div>
        <h2 id="import-title">{t(lang, "imp.title")}</h2>
        <p className="import-hint">
          {t(lang, "imp.hint", { path: "~/.claude/projects/…/*.jsonl" })}
        </p>

        {transcripts.length > 0 && (
          <>
            <p className="import-store-label">{t(lang, "imp.store")}</p>
            <div className="import-store" role="list">
              {transcripts.map((tr) => (
                <button
                  key={tr.path}
                  type="button"
                  className="import-store-row"
                  role="listitem"
                  title={tr.path}
                  onClick={() => loadFromStore(tr)}
                >
                  <span className="import-store-file mono">{tr.file}</span>
                  <span className="import-store-meta">
                    <span className="import-store-project">{tr.project}</span>
                    <span className="tabular">
                      {relativeTime(tr.modifiedAt, Date.now(), lang)} · {formatKb(tr.size)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <textarea
          className="import-paste"
          placeholder={t(lang, "imp.placeholder")}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          rows={6}
        />
        {error !== null && <p className="import-error">{error}</p>}
        <div className="modal-actions">
          <input ref={fileRef} type="file" accept=".jsonl,.json,.txt" hidden onChange={onFile} />
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
            {t(lang, "imp.pick")}
          </button>
          <span className="import-spacer" />
          <button type="button" className="ghost" onClick={props.onClose}>
            {t(lang, "common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={text.trim() === ""}
            onClick={() => load(text, t(lang, "imp.pasted"))}
          >
            {t(lang, "imp.load")}
          </button>
        </div>
      </div>
    </div>
  );
}

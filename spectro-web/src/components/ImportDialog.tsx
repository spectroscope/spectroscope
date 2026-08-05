// Session import: paste or pick a .jsonl — raw spectroscope RunEvents replay
// verbatim; Claude Code transcripts and VS Code agent-mode exports run through
// their adapters. The loaded stream feeds the SAME replay path as a stored
// session, so every tab (chat, graph, flow, lab, trace) renders it with zero
// extra plumbing.
//
// Because ~/.claude is invisible in Finder (a file chooser cannot even get
// there), the dialog also lists the transcripts the server finds under
// ~/.claude/projects. Stage 2 made this a full-screen surface: each row fills
// in with what the facts endpoint knows about it, a two-axis filter (a model
// AND a property, the owner's conjunction) narrows the list, and a statistics
// line says what the current selection adds up to. The list never waits for
// facts — rows render from the listing and fill in as answers land.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { RunEvent } from "../events";
import type { ImportSource } from "../import/detect";
import { detectAndLoad } from "../import/detect";
import { reportBrowserError } from "../state/browserLog";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { relativeTime } from "../format";
import { rowState, formatBytes, listingNotice } from "../import/rowState";
import type { TranscriptRow, StoreLimits } from "../import/rowState";
import { useTranscriptFacts } from "../import/useTranscriptFacts";
import {
  applyFilter,
  emptyFilter,
  filterIsActive,
  modelFamily,
  selectionStats,
  type FactsFilter,
  type FilterProp,
} from "../import/transcriptFilter";

/** How long revealed rows are collected before one batched facts ask goes out. */
const REVEAL_FLUSH_MS = 40;

export function ImportDialog(props: {
  onLoad: (
    events: RunEvent[],
    label: string,
    kind: "spectroscope" | "claude-code" | "vscode-agent",
    source: ImportSource,
  ) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  // What the SAME listing published about its own ceiling. Null until it
  // answers, and null forever against a server too old to say, in which case
  // rowState refuses nothing rather than guessing a number.
  const [limits, setLimits] = useState<StoreLimits | null>(null);
  const [filter, setFilter] = useState<FactsFilter>(emptyFilter());
  const lang = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const { request, factsFor } = useTranscriptFacts();

  useEffect(() => {
    let alive = true;
    fetch("/api/claude/transcripts")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (!alive || body === null || typeof body !== "object") return;
        // One answer carries both, so there is no window in which the dialog has
        // rows but no limit and has to either guess or render them all clickable.
        const listing = body as { limitBytes?: unknown; truncated?: unknown; transcripts?: unknown };
        if (Array.isArray(listing.transcripts)) {
          setTranscripts(listing.transcripts as TranscriptRow[]);
        } else if (Array.isArray(body)) {
          setTranscripts(body as TranscriptRow[]);
        }
        if (typeof listing.limitBytes === "number") {
          setLimits({
            limitBytes: listing.limitBytes,
            // Two limits govern this listing. Read both, or the dialog can only
            // explain the rows it shows and never the ones it does not.
            truncated: listing.truncated === true,
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Escape closes — the DoctorPanel pattern; all three picker dialogs lacked it.
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- facts arrive per VISIBLE row --------------------------------------
  // An IntersectionObserver rooted on the scrolling list asks only for rows on
  // (or near) the screen. Revealed rows are buffered for one tick so a scroll
  // sends one batched ask, not one HTTP call per row. The store dedups by file
  // state, so nothing here worries about asking twice.
  const rowByEl = useRef(new Map<Element, TranscriptRow>());
  const observer = useRef<IntersectionObserver | null>(null);
  const revealBuffer = useRef(new Set<TranscriptRow>());
  const revealTimer = useRef<number | null>(null);

  const flushSoon = useCallback(() => {
    if (revealTimer.current !== null) return;
    revealTimer.current = window.setTimeout(() => {
      revealTimer.current = null;
      const rows = [...revealBuffer.current];
      revealBuffer.current.clear();
      if (rows.length > 0) request(rows);
    }, REVEAL_FLUSH_MS);
  }, [request]);

  const listRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (node === null) return;
      observer.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = rowByEl.current.get(entry.target);
            if (row) revealBuffer.current.add(row);
          }
          flushSoon();
        },
        // One viewport of margin: the rows just off-screen are the ones a
        // scroll reveals next, so their facts are usually in before they land.
        { root: node, rootMargin: "100% 0px" },
      );
      // Children mount before their parent's ref runs, so rows registered
      // ahead of the observer are picked up here.
      for (const el of rowByEl.current.keys()) observer.current.observe(el);
    },
    [flushSoon],
  );

  const rowRef = useCallback((el: HTMLButtonElement | null, tr: TranscriptRow) => {
    if (el === null) return;
    rowByEl.current.set(el, tr);
    observer.current?.observe(el);
  }, []);

  // ---- the filter --------------------------------------------------------
  // An active filter needs facts for every row to answer honestly, so it
  // starts a sweep over the whole listing. The store runs it one batch at a
  // time and announces per batch; rows fill into the filtered list as they
  // answer, and the verdict's `pending` count says how many are still out.
  const active = filterIsActive(filter);
  useEffect(() => {
    if (active && transcripts.length > 0) request(transcripts);
  }, [active, transcripts, request]);

  const verdict = useMemo(() => applyFilter(transcripts, factsFor, filter), [transcripts, factsFor, filter]);
  const stats = useMemo(() => selectionStats(verdict.rows, factsFor), [verdict, factsFor]);

  // The model axis offers what the data holds: every family seen in the facts
  // so far, plus whatever is already selected so a chip cannot vanish from
  // under its own selection while a sweep is still landing.
  const families = useMemo(() => {
    const seen = new Set<string>(filter.models);
    for (const tr of transcripts) {
      for (const id of factsFor(tr)?.models ?? []) seen.add(modelFamily(id));
    }
    return [...seen].sort();
  }, [transcripts, factsFor, filter.models]);

  const toggleModel = (family: string): void =>
    setFilter((f) => ({
      ...f,
      models: f.models.includes(family) ? f.models.filter((m) => m !== family) : [...f.models, family],
    }));

  const toggleProp = (prop: FilterProp): void =>
    setFilter((f) => ({
      ...f,
      props: f.props.includes(prop) ? f.props.filter((p) => p !== prop) : [...f.props, prop],
    }));

  // Every entry point clears the previous error before it starts. Without this
  // a failed pick left its red line standing while the next attempt succeeded,
  // and only the textarea's onChange ever cleared it.
  const load = (raw: string, label: string): void => {
    setError(null);
    try {
      const { events, kind, source } = detectAndLoad(raw);
      // The VS Code export records that a tool ran and whether it succeeded,
      // never what it returned. Say that once, here, rather than leaving the
      // reader to infer it from a screen of empty tool bodies.
      setNote(kind === "vscode-agent" ? t(lang, "imp.vscodeNote") : null);
      props.onLoad(events, label, kind, source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // This is the blind spot the ring exists for: the whole import path runs
      // in the browser and reaches no server, so nothing else records it.
      reportBrowserError("import", e);
    }
  };

  const loadFromStore = (tr: TranscriptRow): void => {
    setError(null);
    fetch(`/api/claude/transcripts/content?path=${encodeURIComponent(tr.path)}`)
      .then((r) => {
        if (r.ok) return r.text();
        // The rows are disabled before the click now, so a refusal here means
        // the listing went stale: the store is live and a transcript can grow
        // past the ceiling between the render and the click. The server names
        // both numbers, so show what it said rather than a bare status.
        if (r.status === 413) {
          return r
            .text()
            .then((why) =>
              Promise.reject(
                new Error(why.trim() === "" ? t(lang, "imp.err.fetch", { status: 413 }) : why.trim()),
              ),
            );
        }
        return Promise.reject(new Error(t(lang, "imp.err.fetch", { status: r.status })));
      })
      .then((raw) => load(raw, tr.file))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    // A rejected read (ejected volume, permission, NotReadableError) used to
    // show the user nothing at all — the dialog simply sat there.
    void file
      .text()
      .then((raw) => load(raw, file.name))
      .catch(() => setError(t(lang, "imp.err.read", { name: file.name })));
  };

  const now = Date.now();

  /** One row's facts, rendered only for what is actually known — a row whose
   *  facts are not in renders nothing extra and fills in when they land. */
  const rowFacts = (tr: TranscriptRow) => {
    const facts = factsFor(tr);
    if (facts === undefined) return null;
    const seen = new Map<string, string[]>();
    for (const id of facts.models) {
      const family = modelFamily(id);
      seen.set(family, [...(seen.get(family) ?? []), id]);
    }
    return (
      <span className="import-store-facts">
        {[...seen.entries()].map(([family, ids]) => (
          <span key={family} className="import-fact-model" title={ids.join(", ")}>
            {family}
          </span>
        ))}
        {facts.workflowCalls > 0 && <span>workflow ×{facts.workflowCalls}</span>}
        {facts.subagents > 0 && <span>subagents ×{facts.subagents}</span>}
        {(facts.workflowAgents ?? 0) > 0 && <span>workflow-agents ×{facts.workflowAgents}</span>}
        {facts.language !== undefined && <span>{facts.language}</span>}
      </span>
    );
  };

  return (
    <div className="modal-backdrop">
      <div className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-head">
          <span className="eyebrow sand">Import</span>
          <button
            type="button"
            className="ghost import-head-close"
            aria-label={t(lang, "imp.close")}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <h2 id="import-title">{t(lang, "imp.title")}</h2>
        <p className="import-hint">{t(lang, "imp.hint", { path: "~/.claude/projects/…/*.jsonl" })}</p>

        {transcripts.length > 0 && (
          <>
            <div className="import-filter">
              <input
                type="search"
                className="import-search"
                placeholder={t(lang, "imp.filter.text")}
                value={filter.text}
                onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
              />
              {families.length > 0 && (
                <span className="import-filter-group" role="group" aria-label={t(lang, "imp.filter.model")}>
                  <span className="import-filter-label">{t(lang, "imp.filter.model")}</span>
                  {families.map((family) => (
                    <button
                      key={family}
                      type="button"
                      className={filter.models.includes(family) ? "import-chip is-on" : "import-chip"}
                      aria-pressed={filter.models.includes(family)}
                      onClick={() => toggleModel(family)}
                    >
                      {family}
                    </button>
                  ))}
                </span>
              )}
              <span className="import-filter-group" role="group" aria-label={t(lang, "imp.filter.with")}>
                <span className="import-filter-label">{t(lang, "imp.filter.with")}</span>
                {(["workflow", "subagents"] as const).map((prop) => (
                  <button
                    key={prop}
                    type="button"
                    className={filter.props.includes(prop) ? "import-chip is-on" : "import-chip"}
                    aria-pressed={filter.props.includes(prop)}
                    onClick={() => toggleProp(prop)}
                  >
                    {t(lang, `imp.chip.${prop}`)}
                  </button>
                ))}
              </span>
            </div>

            {/* Numbers only: what the current selection is, spans, and holds. */}
            <div className="import-stats" data-testid="import-stats">
              <span className="tabular">{t(lang, "imp.stats.transcripts", { n: stats.count })}</span>
              {stats.count > 0 && (
                <span className="tabular">
                  {relativeTime(stats.oldest, now, lang)} → {relativeTime(stats.newest, now, lang)}
                </span>
              )}
              {stats.models.map(([family, sessions]) => (
                <span key={family} className="tabular">
                  {family} ×{sessions}
                </span>
              ))}
              {stats.count > 0 && (
                <>
                  <span className="tabular">{t(lang, "imp.stats.workflow", { n: stats.workflowCalls })}</span>
                  <span className="tabular">{t(lang, "imp.stats.subagents", { n: stats.subagents })}</span>
                  <span className="tabular">
                    {t(lang, "imp.stats.workflowAgents", { n: stats.workflowAgents })}
                  </span>
                </>
              )}
              {stats.unread > 0 && (
                <span className="tabular">{t(lang, "imp.stats.unread", { n: stats.unread })}</span>
              )}
            </div>

            <div className="import-store" role="list" ref={listRef}>
              {verdict.rows.map((tr) => {
                const state = rowState(tr, limits, lang);
                const facts = factsFor(tr);
                return (
                  <button
                    key={tr.path}
                    type="button"
                    className={state.enabled ? "import-store-row" : "import-store-row is-refused"}
                    role="listitem"
                    title={tr.path}
                    disabled={!state.enabled}
                    aria-disabled={!state.enabled}
                    onClick={() => loadFromStore(tr)}
                    ref={(el) => rowRef(el, tr)}
                  >
                    <span className="import-store-file mono">{tr.file}</span>
                    {facts?.firstPrompt !== undefined && (
                      <span className="import-store-prompt" title={facts.firstPrompt}>
                        {facts.firstPrompt}
                      </span>
                    )}
                    <span className="import-store-meta">
                      <span className="import-store-project">{tr.project}</span>
                      <span className="tabular">
                        {relativeTime(tr.modifiedAt, now, lang)} · {formatBytes(tr.size)}
                      </span>
                    </span>
                    {rowFacts(tr)}
                    {!state.enabled && <span className="import-store-refused">{state.reason}</span>}
                  </button>
                );
              })}
            </div>
            {verdict.pending > 0 && (
              <p className="import-store-note">{t(lang, "imp.pendingNote", { n: verdict.pending })}</p>
            )}
            {listingNotice(limits, transcripts.length, lang) !== null && (
              <p className="import-store-note">{listingNotice(limits, transcripts.length, lang)}</p>
            )}
          </>
        )}

        <div className="import-bottom">
          <textarea
            className="import-paste"
            placeholder={t(lang, "imp.placeholder")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            rows={3}
          />
          {error !== null && <p className="import-error">{error}</p>}
          {note !== null && <p className="import-note">{note}</p>}
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
              className="soft-primary"
              disabled={text.trim() === ""}
              onClick={() => load(text, t(lang, "imp.pasted"))}
            >
              {t(lang, "imp.load")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

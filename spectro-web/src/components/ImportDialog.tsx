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
import type { ChangeEvent, DragEvent } from "react";
import type { RunEvent } from "../events";
import type { ImportKind, ImportSource } from "../import/detect";
import { detectAndLoad } from "../import/detect";
import {
  groupPickedFiles,
  importClaudeCodeRun,
  runSummary,
  type ImportedRunSummary,
  type PickedCopilotFolder,
  type RunStateText,
  type SidecarText,
} from "../import/claudeCodeRun";
import {
  copilotSideFile,
  copilotStoreRows,
  loadCopilotFolder,
  pickedAlone,
  pickedOnItsOwn,
  readCopilotFolder,
  replacesShown,
  type CopilotStoreRow,
} from "../import/copilotFolder";
import { reportBrowserError } from "../state/browserLog";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { relativeTime } from "../format";
import { formatBytes, rowState, listingNotice } from "../import/rowState";
import { StoreRow } from "./StoreRow";
import { toolOutputNote } from "./importBar";
import type { TranscriptRow, StoreLimits } from "../import/rowState";
import { onLoadArgs, openFromStore, type StoreDoor } from "../import/storeDoor";
import type { SubagentTranscript } from "../import/subagentFile";
import { useTranscriptFacts } from "../import/useTranscriptFacts";
import { readSpectroPick, type ImportWires } from "../import/wireImport";
import { missingGists, useGists } from "../import/useGists";
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

/**
 * The list a folder of Copilot session folders opens (card 605, task 12):
 * one button per session folder, newest first, each with its name, when it
 * was created, its client, the size of its events.jsonl and a mark when it
 * was still running. A press chooses the folder; nothing loads before that.
 */
export function CopilotStoreList(props: {
  lang: Lang;
  rows: readonly CopilotStoreRow[];
  /** Folders with the layout and no events.jsonl, counted and not listed. */
  skipped: number;
  /** "now" for the relative time, passed so the list renders one clock. */
  now: number;
  /** A load is in flight: every row waits. */
  busy: boolean;
  onPick: (session: number) => void;
}) {
  const { lang, rows, skipped } = props;
  const lead = [t(lang, "imp.copilot.store", { n: rows.length })];
  if (skipped > 0)
    lead.push(
      t(lang, skipped === 1 ? "imp.copilot.storeSkippedOne" : "imp.copilot.storeSkipped", { n: skipped }),
    );
  return (
    <div className="import-copilot-store">
      <p className="import-store-note">{lead.join(" ")}</p>
      <div className="import-store" role="list" aria-label={lead[0]}>
        {rows.map((row) => (
          <div key={row.session} className="import-store-line" role="listitem">
            <button
              type="button"
              className="import-store-row"
              title={new Date(row.created).toISOString()}
              disabled={props.busy}
              onClick={() => props.onPick(row.session)}
            >
              <span className="import-store-file">{row.name ?? t(lang, "imp.copilot.unnamed")}</span>
              <span className="import-store-meta">
                {row.client !== null && <span className="import-store-project mono">{row.client}</span>}
                <span className="tabular">
                  {relativeTime(row.created, props.now, lang)} · {formatBytes(row.bytes)}
                </span>
                {row.live && <span className="import-store-brings">{t(lang, "imp.copilot.liveMark")}</span>}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImportDialog(props: {
  onLoad: (
    events: RunEvent[],
    label: string,
    kind: ImportKind,
    source: ImportSource,
    /** What the file said about itself when it was one agent's transcript
     *  rather than a session's (card 152); absent for every other file. */
    subagent?: SubagentTranscript,
    /** Where the file lives in the store, when it came from there. Only a
     *  store path has agents beside it to look for (card 177); a pasted body
     *  and a picked file have no address, and say so by carrying none. */
    storePath?: string,
    /** What a RUN import measured (card 291): a session picked together with
     *  its subagents/ set. Absent for every single-file import, which is what
     *  keeps that path exactly as it was. */
    run?: ImportedRunSummary,
    /** One sentence this import owes the reader beyond its own counts (card
     *  318): the run was over the server's ceiling, so what arrived is the
     *  session file and the agents beside it stayed on disk. It travels WITH
     *  the import because this dialog is gone by the time it is read — the
     *  same reason the children counts do. */
    note?: string,
    /** Card 473: what came with a spectroscope session file: a bundle's
     *  entries, or wires picked or dropped beside it. */
    wires?: ImportWires,
    /** Card 605, task 12: a Copilot folder load of the session already on
     *  screen, by its session id, so it replaces that session. */
    replace?: boolean,
  ) => void;
  onClose: () => void;
  /** Files picked before the dialog opened (the import bar's folder pick),
   *  taken once as a pick when the dialog mounts. */
  initialFiles?: File[];
  /** The session id of the Copilot session on screen whose folder the bar
   *  asked for, or null. */
  sameSession?: string | null;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The row a store load is in flight for, or null. One click, one load. */
  const [loading, setLoading] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  // What the SAME listing published about its own ceiling. Null until it
  // answers, and null forever against a server too old to say, in which case
  // rowState refuses nothing rather than guessing a number.
  const [limits, setLimits] = useState<StoreLimits | null>(null);
  const [filter, setFilter] = useState<FactsFilter>(emptyFilter());
  /** A folder of Copilot session folders, listed and waiting for a choice (task 12 item 5). */
  const [copilotStore, setCopilotStore] = useState<{
    files: File[];
    sessions: PickedCopilotFolder[];
    skipped: number;
    rows: CopilotStoreRow[];
  } | null>(null);
  const lang = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
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
  // Card 179 stage 3. The buttons act on what is ON SCREEN, so a filter is also
  // how an operator says "only gist these" — pressing with 300 rows showing and
  // pressing with 6 are different prices, and the label says which one this is.
  const gists = useGists();
  const shownPaths = useMemo(() => verdict.rows.map((r) => r.path), [verdict]);
  const gistsMissing = useMemo(() => missingGists(shownPaths, gists.byPath), [shownPaths, gists.byPath]);

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
  const load = (
    raw: string,
    label: string,
    storePath?: string,
    note?: string,
    wires?: ImportWires,
    /** A file picked or dropped on its own (task 12 item 6). */
    picked = false,
  ): void => {
    setError(null);
    try {
      const loaded = detectAndLoad(raw);
      const { events, kind, subagent } = loaded;
      const source = picked ? pickedAlone(loaded.source) : loaded.source;
      // Tool results whose record held no output stay empty; say how many
      // once, here, rather than leaving a screen of empty tool bodies.
      setNote(toolOutputNote(lang, source.toolOutputs));
      props.onLoad(events, label, kind, source, subagent, storePath, undefined, note, wires);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // This is the blind spot the ring exists for: the whole import path runs
      // in the browser and reaches no server, so nothing else records it.
      reportBrowserError("import", e);
    }
  };

  /**
   * A row's click, through the door the row already named.
   *
   * Card 318. The merge that loads a workflow run's agents INTO the stream has
   * shipped since card 291 and was reachable only from the folder picker; this
   * list — the door the owner actually uses — asked for the session file alone,
   * so a session with hundreds of agents beside it opened with none of them.
   * The row's plan (rowState) decides which door, off the same fold that prints
   * its `workflow-agents` chip, and the DEFAULT is the run. Nobody is sent to
   * find a directory.
   *
   * WIRING ONLY. The door itself is `import/storeDoor.ts`, because a closure in
   * a component can only be guarded by searching this file for substrings — and
   * a reviewer restored the defect three ways with all of those green. The
   * arguments below are spread from `onLoadArgs`, which is measured, so this
   * call site cannot quietly lose the store path the way it did once already.
   *
   * @param tr the listing row
   * @param door which door: the whole run, or the session file on its own
   * @param agents what the row said sits beside this session, for the sentence
   *        a degrade has to print
   */
  const loadFromStore = (tr: TranscriptRow, door: StoreDoor, agents: number): void => {
    // One click, one load. The run door can carry a hundred megabytes and the
    // browser is then busy for tens of seconds with the parse, the merge and the
    // fold — during which the row stayed clickable and a second press fired a
    // second whole bundle. Measured by a reviewer: two requests 402 ms apart,
    // 117 MB each.
    if (loading !== null) return;
    setError(null);
    setLoading(tr.path);
    openFromStore(tr, door, agents, lang)
      .then((result) => {
        // Tool results whose record held no output stay empty; say how many once.
        setNote(toolOutputNote(lang, result.source.toolOutputs));
        props.onLoad(...onLoadArgs(result));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        // The blind spot the ring exists for: the whole import path runs in the
        // browser and reaches no server, so nothing else records it.
        reportBrowserError("import", e);
      })
      .finally(() => setLoading(null));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const list = Array.from(e.target.files ?? []);
    // Same selection twice must fire twice: a file input keeps its value.
    e.target.value = "";
    takeFiles(list);
  };

  // Card 473: files dropped on the dialog take the same road as picked ones.
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    takeFiles(Array.from(e.dataTransfer.files));
  };

  /**
   * One Copilot session folder (card 605, task 12): the files the grouping
   * named are read, and the folder loads as a whole. A folder whose
   * events.jsonl is not a Copilot session loads as whatever it is.
   */
  const loadCopilotPick = (list: File[], pick: PickedCopilotFolder): void => {
    // One press, one load: a store row stays pressable while its folder reads.
    if (loading !== null) return;
    setError(null);
    setLoading(`copilot:${pick.folder}`);
    void readCopilotFolder(list, pick)
      .then((texts) => {
        const got = loadCopilotFolder(texts);
        setNote(toolOutputNote(lang, got.source.toolOutputs));
        props.onLoad(
          got.events,
          got.label,
          got.kind,
          got.source,
          got.subagent,
          undefined,
          got.run,
          undefined,
          undefined,
          replacesShown(got.source, props.sameSession),
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        reportBrowserError("import", err);
      })
      .finally(() => setLoading(null));
  };

  const takeFiles = (list: File[]): void => {
    if (list.length === 0) return;
    setError(null);
    setCopilotStore(null);
    // Card 473: a bundle, or a session with its wires beside it, goes first.
    // A pick with neither falls through to the grouping below, unchanged.
    if (list.some((f) => /\.(spectro\.zip|llm\.jsonl|browser\.jsonl)$/.test(f.name))) {
      // A bundle is checked and decoded in slices (bundleZip.ts); the dialog
      // says how far it got, since the opening sign comes only after it closes.
      void readSpectroPick(list, {
        onProgress: (done, total) =>
          setNote(t(lang, "imp.readingBundle", { pct: total <= 0 ? 0 : Math.floor((done / total) * 100) })),
      })
        .then((got) => {
          setNote(null);
          if (got === null) return;
          load(got.session.text, got.session.name, undefined, undefined, got.wires);
        })
        .catch((err: unknown) => {
          setNote(null);
          setError(err instanceof Error ? err.message : String(err));
          reportBrowserError("import", err);
        });
      return;
    }
    const group = groupPickedFiles(
      list.map((f) => ({
        name: f.name,
        relativePath: (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "",
      })),
    );
    if (group.kind === "none") {
      setError(t(lang, "imp.err.noSession"));
      return;
    }
    if (group.kind === "many") {
      setError(t(lang, "imp.err.manySessions", { n: group.count }));
      return;
    }
    if (group.kind === "copilot") {
      loadCopilotPick(list, group.session);
      return;
    }
    if (group.kind === "copilot-store") {
      // A list, not a load: only the workspace.yaml files are read to build it.
      void copilotStoreRows(list, group.sessions)
        .then((rows) =>
          setCopilotStore({ files: list, sessions: group.sessions, skipped: group.skipped, rows }),
        )
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          reportBrowserError("import", err);
        });
      return;
    }
    if (group.kind === "single") {
      // ONE file takes today's path byte for byte (card 291 pins the
      // grouping; the read-and-load below is untouched card-152 territory).
      // A rejected read (ejected volume, permission, NotReadableError) used
      // to show the user nothing at all — the dialog simply sat there.
      const file = list[group.session];
      void file
        .text()
        // Card 473: the file's own name, so an old session finds its wire on
        // this machine by the id convention.
        .then((raw) => {
          // A side file of a Copilot folder is named as one, not as invalid JSONL (task 12 item 7).
          if (copilotSideFile(file.name, raw)) {
            setError(t(lang, "imp.copilot.sideFile"));
            return;
          }
          load(
            raw,
            file.name,
            undefined,
            undefined,
            {
              sessionFileName: file.name,
              llm: null,
              browser: null,
              children: [],
              from: "files",
            },
            pickedOnItsOwn(file),
          );
        })
        .catch(() => setError(t(lang, "imp.err.read", { name: file.name })));
      return;
    }
    // A run: the session stream plus its sidecars, merged by the coordinator.
    // A sidecar file that cannot be read degrades to an empty text, which the
    // coordinator skips and COUNTS — the banner then says so, instead of the
    // dialog throwing the whole session away over one unreadable child.
    const session = list[group.session];
    const readRun = async (): Promise<void> => {
      const sessionText = await session.text();
      const sidecars: SidecarText[] = [];
      for (const s of group.sidecars) {
        sidecars.push({
          jsonlText: await list[s.jsonl].text().catch(() => ""),
          metaJson: s.meta === null ? "" : await list[s.meta].text().catch(() => ""),
          ...(s.runId !== null ? { runId: s.runId } : {}),
        });
      }
      // Card 297: a workflow run's own state file, when the pick carried one.
      // An unreadable one degrades to "" — the coordinator then labels that
      // run's children off their own prompts instead of losing them.
      const runStates: RunStateText[] = [];
      for (const r of group.runStates) {
        runStates.push({ runId: r.runId, json: await list[r.file].text().catch(() => "") });
      }
      const run = importClaudeCodeRun({ sessionText, sidecars, runStates });
      setNote(toolOutputNote(lang, run.source.toolOutputs));
      // The summary is built by the importer's own `runSummary`, never by a
      // literal here. A literal is where a measured field goes missing without
      // anything turning red — `declared` did exactly that (card 315).
      props.onLoad(run.events, session.name, run.kind, run.source, run.subagent, undefined, runSummary(run));
    };
    void readRun().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      // The blind spot the ring exists for: the whole import path runs in the
      // browser and reaches no server, so nothing else records it.
      reportBrowserError("import", err);
    });
  };

  // The import bar's folder pick (task 12 item 6): its files are taken once,
  // as if they had been picked here.
  const tookInitial = useRef(false);
  useEffect(() => {
    if (props.initialFiles !== undefined && !tookInitial.current) {
      tookInitial.current = true;
      takeFiles(props.initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {(facts.images ?? 0) > 0 && <span>images ×{facts.images}</span>}
        {facts.language !== undefined && <span>{facts.language}</span>}
      </span>
    );
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
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

        {copilotStore !== null && (
          <CopilotStoreList
            lang={lang}
            rows={copilotStore.rows}
            skipped={copilotStore.skipped}
            now={now}
            busy={loading !== null}
            onPick={(i) => loadCopilotPick(copilotStore.files, copilotStore.sessions[i])}
          />
        )}

        {transcripts.length > 0 && (
          <>
            <div className="import-gists">
              {/* A press, never a side effect of opening: this is the one thing
                  on the row that costs a model call. The plain button does the
                  ones that have none — pressing it again after adding
                  transcripts is cheap by construction. */}
              <button
                type="button"
                className="import-gist-run"
                disabled={gists.working || gistsMissing.length === 0}
                onClick={() => gists.run(gistsMissing)}
                title={t(lang, "imp.gist.runWhat")}
              >
                {gists.working
                  ? t(lang, "imp.gist.working")
                  : t(lang, "imp.gist.run", { n: gistsMissing.length })}
              </button>
              <button
                type="button"
                className="import-gist-all"
                disabled={gists.working || shownPaths.length === 0}
                onClick={() => gists.runAll(shownPaths)}
                title={t(lang, "imp.gist.allWhat")}
              >
                {t(lang, "imp.gist.all")}
              </button>
              {gists.error !== null && <span className="import-gist-bad">{gists.error}</span>}
              {gists.error === null && gists.written !== null && (
                <span className="import-gist-note">{t(lang, "imp.gist.wrote", { n: gists.written })}</span>
              )}
            </div>
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
                {(["workflow", "subagents", "images"] as const).map((prop) => (
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
                  <span className="tabular">{t(lang, "imp.stats.images", { n: stats.images })}</span>
                </>
              )}
              {stats.unread > 0 && (
                <span className="tabular">{t(lang, "imp.stats.unread", { n: stats.unread })}</span>
              )}
            </div>

            <div className="import-store" role="list" ref={listRef}>
              {verdict.rows.map((tr) => {
                const facts = factsFor(tr);
                // The facts go IN, so the verdict and the door come out of one
                // call: which agents sit beside this session is the same
                // reading that prints the chip below, and a second answer to
                // that question on the same row is how a panel starts
                // contradicting itself (card 313, one surface earlier).
                const state = rowState(tr, limits, lang, facts);
                // Told only when it is known. A row whose facts have not landed
                // still takes the run door — with nothing beside a session the
                // bundle IS the file — but it must not print a count nobody
                // measured.
                // Two different questions, and they were one condition until a
                // reviewer pointed at the window between them: the LABEL needs a
                // measured count and must not print one nobody has, but the
                // ESCAPE only needs to know which door the click takes. Gating
                // both on the count meant the first click after the dialog opens
                // — facts still in flight, run door taken — had no warning AND
                // no way out.
                // The row is its own component (StoreRow): as JSX in here the
                // only guard reachable was a substring search over this file,
                // and a reviewer rewired the press to the session door with
                // every case green. As an element its buttons can be found and
                // their handlers called.
                return (
                  <StoreRow
                    key={tr.path}
                    tr={tr}
                    state={state}
                    lang={lang}
                    now={now}
                    busy={loading !== null}
                    loadingThis={loading === tr.path}
                    rowRef={(el) => rowRef(el, tr)}
                    onOpen={(door) => loadFromStore(tr, door, state.plan.agents)}
                    chips={
                      <>
                        {facts?.firstPrompt !== undefined && (
                          <span className="import-store-prompt" title={facts.firstPrompt}>
                            {facts.firstPrompt}
                          </span>
                        )}
                        {gists.byPath.get(tr.path) !== undefined && (
                          /* Marked as written by a model, with which one. It is
                           a reading of the opening prompt, not a fact off the
                           file, and the row says so rather than letting it pass
                           as one. */
                          <span
                            className="import-store-gist"
                            title={`${gists.byPath.get(tr.path)?.model ?? ""}${
                              gists.byPath.get(tr.path)?.stale ? " · the file has changed since" : ""
                            }`}
                          >
                            {gists.byPath.get(tr.path)?.stale ? "≈ " : "~ "}
                            {gists.byPath.get(tr.path)?.text}
                          </span>
                        )}
                        {rowFacts(tr)}
                      </>
                    }
                  />
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
            <input
              ref={fileRef}
              type="file"
              accept=".jsonl,.json,.txt,.zip,.yaml,.md"
              multiple
              hidden
              onChange={onFile}
            />
            {/* webkitdirectory is not in React's input typing; the spread puts
                the attribute on the element without claiming it is. */}
            <input
              ref={dirRef}
              type="file"
              hidden
              onChange={onFile}
              {...({ webkitdirectory: "" } as Record<string, string>)}
            />
            <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
              {t(lang, "imp.pick")}
            </button>
            <button type="button" className="ghost" onClick={() => dirRef.current?.click()}>
              {t(lang, "imp.pickFolder")}
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

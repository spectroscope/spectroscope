// Card 604: the store of the files tab's model reading. It follows
// state/runAnalysis.ts (card 294): module-level state per session view,
// published through useSyncExternalStore, one AbortController per run, so a
// reading survives closing the sheet or switching tabs and lives in app state
// only (P5).
//
// Nothing leaves without the click. The only fetches here are the pre-flight,
// fired by the "analyze with model" press, and the reading, fired by the
// consent sheet's send press. Both carry the provider and model the person
// picked and nothing falls back to the chat's default. No digest, output or
// answer is written to a log.

import { useMemo, useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import {
  emptyAnalysis,
  parseAnalysisChunk,
  type AnalysisMeta,
  type AnalysisState,
  type AnalyzeEngineReport,
} from "../state/runAnalysis";
import type { FilesDigest } from "./digest";
import type { FileLedger } from "./fold";
import { mergeModel, readModelAnswer } from "./modelReading";

export interface ModelPick {
  provider: string;
  model: string;
}

/** The switch in the toolbar: the heuristic alone, or with a model's reading. */
export type ReadingMode = "heuristic" | "model";

/** Where the last pair chosen for this analysis is remembered. */
export const PICK_STORAGE_KEY = "spectro.filesTab.analysisPick";

/**
 * The stream a reading was made on: the event the digest's first call came
 * from, at its index, and how many events the stream held when the digest was
 * frozen. A live chat keeps its view key across /clear, so the key alone
 * cannot tell whether the stream on screen is the one the reading read.
 */
export interface ReadingStamp {
  /** The digest's first call: its event index and its event; null for a digest without calls. */
  first: { at: number; event: RunEvent } | null;
  /** The number of events when the digest was frozen. */
  count: number;
}

/** An open consent sheet: what it asked the server about, and what it will send. */
export interface FilesConsentState {
  pick: ModelPick;
  /** Frozen when the sheet opens, so what the sheet shows is what is sent. */
  digest: FilesDigest;
  /** The stream the digest was frozen from; the reading carries it. */
  stamp: ReadingStamp;
  /** The server's pre-flight, null while it is being asked. */
  report: AnalyzeEngineReport | null;
  /** A pre-flight that could not be made. */
  error: string | null;
}

// ---- the remembered pick --------------------------------------------------

export function loadPick(): ModelPick | null {
  try {
    const raw = localStorage.getItem(PICK_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ModelPick> | null;
    const { provider, model } = parsed ?? {};
    if (typeof provider !== "string" || typeof model !== "string" || provider === "" || model === "")
      return null;
    return { provider, model };
  } catch {
    return null; // no storage, blocked storage, or a value that is not JSON
  }
}

export function savePick(pick: ModelPick): void {
  try {
    localStorage.setItem(PICK_STORAGE_KEY, JSON.stringify({ provider: pick.provider, model: pick.model }));
  } catch {
    // a blocked storage costs the remembered pick, nothing else
  }
}

// ---- the wire --------------------------------------------------------------

/**
 * Asks the server whether the picked pair can run. A non-200 throws: the
 * origin fence answers 404 with no body, and a made-up report would be the
 * failing button this pre-flight exists to prevent.
 */
export async function fetchFilesEngine(pick: ModelPick): Promise<AnalyzeEngineReport> {
  const query = `provider=${encodeURIComponent(pick.provider)}&model=${encodeURIComponent(pick.model)}`;
  const res = await fetch(`/api/files/analyze/engine?${query}`);
  if (!res.ok) throw new Error(`files analyze engine ${res.status}`);
  return (await res.json()) as AnalyzeEngineReport;
}

// ---- the stream a reading belongs to ---------------------------------------

/**
 * The stamp of a digest built from `ledger` while `events` were on screen. A
 * cut digest leaves out the oldest calls, so its first call is the one
 * `digest.calls` from the end.
 */
export function stampOf(ledger: FileLedger, digest: FilesDigest, events: readonly RunEvent[]): ReadingStamp {
  const call = digest.calls > 0 ? ledger.calls[ledger.calls.length - digest.calls] : undefined;
  const event = call === undefined ? undefined : events[call.callIndex];
  return {
    first: call === undefined || event === undefined ? null : { at: call.callIndex, event },
    count: events.length,
  };
}

/**
 * True while `events` still hold the stream a stamp was taken on: at least as
 * many events, and the very event of the digest's first call at its index.
 * A stream that only grew keeps both; a cleared or replaced one keeps neither.
 */
export function readingHolds(stamp: ReadingStamp, events: readonly RunEvent[]): boolean {
  if (events.length < stamp.count) return false;
  return stamp.first === null || events[stamp.first.at] === stamp.first.event;
}

// ---- the per-view store ----------------------------------------------------

const views = new Map<string, AnalysisState>();
const stamps = new Map<string, ReadingStamp>();
const consents = new Map<string, FilesConsentState | null>();
const listeners = new Set<() => void>();
const running = new Map<string, AbortController>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One view's reading; the non-reactive read, visible for tests. */
export function filesAnalysisOf(viewKey: string): AnalysisState {
  const known = views.get(viewKey);
  if (known !== undefined) return known;
  // Seeded on first read, so the snapshot keeps one identity per view.
  const seeded = emptyAnalysis();
  views.set(viewKey, seeded);
  return seeded;
}

function patch(viewKey: string, next: Partial<AnalysisState>): void {
  views.set(viewKey, { ...filesAnalysisOf(viewKey), ...next });
  notify();
}

export function useFilesAnalysis(viewKey: string): AnalysisState {
  const read = (): AnalysisState => filesAnalysisOf(viewKey);
  return useSyncExternalStore(subscribe, read, read);
}

/** The store's part of a reset: the reading, its stamp and a run in flight. */
function forget(viewKey: string): void {
  running.get(viewKey)?.abort();
  running.delete(viewKey);
  stamps.delete(viewKey);
  views.set(viewKey, emptyAnalysis());
}

/** Forgets a view's reading and stops a run in flight. */
export function resetFilesAnalysis(viewKey: string): void {
  forget(viewKey);
  notify();
}

/**
 * The reset for a reading of another stream under the same key, as after
 * /clear in a live chat: the view would otherwise place the model's entries
 * on the new stream's calls by their index. It runs while the view renders,
 * so it tells the listeners after the render; the view takes the reset in the
 * same render and reads the store again when it commits.
 *
 * @return true when the reading was dropped
 */
export function dropStaleReading(viewKey: string, events: readonly RunEvent[]): boolean {
  const stamp = stamps.get(viewKey);
  if (stamp === undefined || readingHolds(stamp, events)) return false;
  forget(viewKey);
  queueMicrotask(notify);
  return true;
}

/**
 * The send press: this digest to this pair, once. A newer run on the same
 * view replaces an older one; another view is never touched.
 *
 * @param viewKey the session view the reading belongs to
 * @param digest  the text the consent sheet showed
 * @param pick    the provider and model the person picked
 * @param lang    the language of the model's reasons
 * @param stamp   the stream the digest was frozen from (`stampOf`)
 */
export async function startFilesAnalysis(
  viewKey: string,
  digest: string,
  pick: ModelPick,
  lang: Lang,
  stamp: ReadingStamp,
): Promise<void> {
  running.get(viewKey)?.abort();
  const controller = new AbortController();
  running.set(viewKey, controller);
  stamps.set(viewKey, stamp);
  const owned = (): boolean => running.get(viewKey) === controller;

  patch(viewKey, { status: "running", meta: null, text: "", error: null });

  let meta: AnalysisMeta | null = null;
  let text = "";
  let closed = false;
  let failed: string | null = null;

  try {
    const res = await fetch("/api/files/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, provider: pick.provider, model: pick.model, lang }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      if (owned()) patch(viewKey, { status: "error", error: await errorOf(res) });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parsed = parseAnalysisChunk(pending, decoder.decode(value, { stream: true }));
      pending = parsed.pending;
      for (const msg of parsed.messages) {
        if (msg.meta !== undefined) meta = msg.meta;
        if (msg.delta !== undefined) text += msg.delta;
        if (msg.done === true) closed = true;
        if (msg.error !== undefined) failed = msg.error;
      }
      if (owned()) patch(viewKey, { meta, text });
    }
    if (!owned()) return;
    if (failed !== null) patch(viewKey, { status: "error", error: failed });
    // A stream without the server's last line was cut, and half a reading is not the reading.
    else if (!closed) patch(viewKey, { status: "error", error: t(currentLang(), "filesTab.model.cutShort") });
    else patch(viewKey, { status: "done" });
  } catch (thrown) {
    if (!owned() || controller.signal.aborted) return;
    patch(viewKey, { status: "error", error: thrown instanceof Error ? thrown.message : String(thrown) });
  } finally {
    if (running.get(viewKey) === controller) running.delete(viewKey);
  }
}

/** The server's readable refusal, or the bare status. */
async function errorOf(res: Response): Promise<string> {
  try {
    const parsed = (await res.json()) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // no JSON body: the status is what there is
  }
  return `HTTP ${res.status}`;
}

// ---- the consent sheet -------------------------------------------------------

/** One view's open sheet, or null; the non-reactive read, visible for tests. */
export function filesConsentOf(viewKey: string): FilesConsentState | null {
  return consents.get(viewKey) ?? null;
}

export function useFilesConsent(viewKey: string): FilesConsentState | null {
  const read = (): FilesConsentState | null => filesConsentOf(viewKey);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The "analyze with model" press: opens the sheet with the digest it will
 * send and asks the server whether the pair can run. The answer lands only on
 * the sheet that asked; a sheet closed or opened again in the meantime keeps
 * its own.
 */
export function openFilesConsent(
  viewKey: string,
  pick: ModelPick,
  digest: FilesDigest,
  stamp: ReadingStamp,
): void {
  const asked: FilesConsentState = { pick, digest, stamp, report: null, error: null };
  consents.set(viewKey, asked);
  notify();
  const land = (next: Partial<FilesConsentState>): void => {
    if (consents.get(viewKey) !== asked) return;
    consents.set(viewKey, { ...asked, ...next });
    notify();
  };
  fetchFilesEngine(pick).then(
    (report) => land({ report }),
    (failed: unknown) => land({ error: failed instanceof Error ? failed.message : String(failed) }),
  );
}

export function closeFilesConsent(viewKey: string): void {
  if (!consents.has(viewKey)) return;
  consents.delete(viewKey);
  notify();
}

// ---- the ledger the tab shows ------------------------------------------------

/**
 * The view's reading and the ledger the tab shows: the heuristic one, with
 * the model's entries merged while the switch is on the model and the reading
 * is the asked-for JSON. Switching back hides the reading; the store keeps it.
 * A reading of another stream than `events` is gone (`dropStaleReading`).
 */
export function useShownLedger(
  viewKey: string,
  heuristic: FileLedger,
  mode: ReadingMode,
  events: readonly RunEvent[],
): { ledger: FileLedger; analysis: AnalysisState; modelShown: boolean } {
  const stored = useFilesAnalysis(viewKey);
  const analysis = dropStaleReading(viewKey, events) ? filesAnalysisOf(viewKey) : stored;
  const entries = useMemo(
    () => (analysis.status === "done" ? readModelAnswer(analysis.text) : null),
    [analysis],
  );
  const shown = mode === "model" ? entries : null;
  const ledger = useMemo(
    () => (shown === null ? heuristic : mergeModel(heuristic, shown)),
    [heuristic, shown],
  );
  return { ledger, analysis, modelShown: shown !== null };
}

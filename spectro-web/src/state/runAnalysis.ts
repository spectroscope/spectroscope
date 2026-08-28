// The run-analysis store (card 294): the OPT-IN one-shot reading of an
// imported run. The module owns the fetch, the per-view state and the lenient
// result parse; the digest it sends comes from runDigest.ts and the consent
// UI lives in components/AnalyzeRun.tsx.
//
// The rule this file exists to keep: NOTHING LEAVES THE MACHINE WITHOUT THE
// CLICK. Importing a run builds no request, reading the store builds no
// request; the only fetches in here are fetchAnalyzeEngine (the consent
// dialog's pre-flight, itself behind the affordance click) and startAnalysis
// (the consent click). One click is one call; analyzing again is another click.
//
// The store follows translate.ts: module-level per-view state, published via
// useSyncExternalStore, so the run survives closing the sheet or switching
// tabs — and the result lives in app state ONLY. No persistence in this cut;
// a sidecar file would be a later card.

import { useSyncExternalStore } from "react";
import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import { currentLang } from "./lang";

// ---- the wire ------------------------------------------------------------

/** What the server said it would spend the call on — promised by the consent
 *  dialog BEFORE the click (via {@link fetchAnalyzeEngine}), confirmed by the
 *  stream's meta line AFTER. */
export interface AnalysisMeta {
  provider: string;
  model: string;
  address: string;
}

/** GET /api/analyze/engine: the pre-flight, so no consent button can fail. */
export interface AnalyzeEngineReport {
  available: boolean;
  provider?: string;
  model?: string;
  address?: string;
  /** provider-is-local | needs-key, when unavailable. */
  reason?: string;
  detail?: string;
}

/** One parsed NDJSON line of the analysis stream. */
export interface AnalysisMessage {
  meta?: AnalysisMeta;
  delta?: string;
  done?: boolean;
  error?: string;
}

/**
 * Ask the server what one analysis call would actually do. A non-200 throws
 * rather than parses: the fence answers 404 with no body, and a fabricated
 * "available" would be exactly the failing button this endpoint prevents.
 */
export async function fetchAnalyzeEngine(): Promise<AnalyzeEngineReport> {
  const res = await fetch("/api/analyze/engine");
  if (!res.ok) throw new Error(`analyze engine ${res.status}`);
  return (await res.json()) as AnalyzeEngineReport;
}

/**
 * Cut a chunk of NDJSON into parsed lines plus the partial tail. A line that
 * does not parse is skipped, not fatal — one mangled line must not cost the
 * reading (the translate driver's contract).
 */
export function parseAnalysisChunk(
  pending: string,
  chunk: string,
): { pending: string; messages: AnalysisMessage[] } {
  const whole = pending + chunk;
  const lines = whole.split("\n");
  const tail = lines.pop() ?? "";
  const messages: AnalysisMessage[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      messages.push(JSON.parse(line) as AnalysisMessage);
    } catch {
      // a mangled line is dropped; the terminal {done}/{error} still decides
    }
  }
  return { pending: tail, messages };
}

// ---- the per-view store ---------------------------------------------------

export type AnalysisStatus = "idle" | "running" | "done" | "error";

/** One session view's analysis: the progress and the result — app state only. */
export interface AnalysisState {
  status: AnalysisStatus;
  /** What the call actually used, from the stream's meta line. */
  meta: AnalysisMeta | null;
  /** Everything the model streamed, verbatim. */
  text: string;
  /** A terminal failure, readable, shown verbatim. */
  error: string | null;
}

export function emptyAnalysis(): AnalysisState {
  return { status: "idle", meta: null, text: "", error: null };
}

const views = new Map<string, AnalysisState>();
const listeners = new Set<() => void>();
/** The run in flight, per view — a newer run supersedes an older one. */
const running = new Map<string, AbortController>();

/** Visible for tests, and the non-reactive read for imperative callers. */
export function analysisOf(viewKey: string): AnalysisState {
  const known = views.get(viewKey);
  if (known !== undefined) return known;
  // Seeded on first read so the snapshot keeps ONE identity per view.
  const seeded = emptyAnalysis();
  views.set(viewKey, seeded);
  return seeded;
}

function patch(viewKey: string, next: Partial<AnalysisState>): void {
  views.set(viewKey, { ...analysisOf(viewKey), ...next });
  for (const listener of listeners) listener();
}

/** Forget a view's analysis. Re-analyzing afterwards is another click. */
export function resetAnalysis(viewKey: string): void {
  running.get(viewKey)?.abort();
  running.delete(viewKey);
  patch(viewKey, emptyAnalysis());
}

/**
 * The consent click: send THIS digest to the configured provider, once.
 *
 * The fetch lives in this module, not in the component, so closing the sheet
 * or switching tabs does not cancel the run. The digest arrives as an
 * argument — the caller shows the same string in the consent step, so what
 * was promised is what is sent.
 *
 * @param viewKey the session view (an import's replay id)
 * @param digest  the prepared digest text (runDigest.ts)
 * @param lang    the answer language, en | de
 */
export async function startAnalysis(viewKey: string, digest: string, lang: Lang): Promise<void> {
  running.get(viewKey)?.abort();
  const controller = new AbortController();
  running.set(viewKey, controller);
  const owned = (): boolean => running.get(viewKey) === controller;

  patch(viewKey, { status: "running", meta: null, text: "", error: null });

  let meta: AnalysisMeta | null = null;
  let text = "";
  let closed = false;
  let failed: string | null = null;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, lang }),
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
    if (failed !== null) {
      patch(viewKey, { status: "error", error: failed });
    } else if (!closed) {
      // A stream that ended without the server's terminal marker was cut, not
      // finished — presenting half a reading as the reading would be a lie.
      patch(viewKey, { status: "error", error: t(currentLang(), "an.cutShort") });
    } else {
      patch(viewKey, { status: "done" });
    }
  } catch (thrown) {
    if (!owned()) return;
    if (controller.signal.aborted) return; // superseded or reset — the newer run owns the view
    patch(viewKey, { status: "error", error: thrown instanceof Error ? thrown.message : String(thrown) });
  } finally {
    if (running.get(viewKey) === controller) running.delete(viewKey);
  }
}

/** The server's readable 503/400 message, or the bare status. */
async function errorOf(res: Response): Promise<string> {
  try {
    const parsed = (await res.json()) as { error?: string };
    if (parsed.error !== undefined) return parsed.error;
  } catch {
    // no JSON body — the status is what we have
  }
  return `HTTP ${res.status}`;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The read hook: one session view's analysis state. */
export function useAnalysis(viewKey: string): AnalysisState {
  const read = (): AnalysisState => analysisOf(viewKey);
  return useSyncExternalStore(subscribe, read, read);
}

// ---- the lenient result parse ---------------------------------------------

/** The asked-for shape: a run summary plus a line or two per agent. */
export interface AnalysisReading {
  summary: string;
  agents: { id: string; reading: string }[];
}

/**
 * Read the model's answer as the asked-for JSON, LENIENTLY: a bare object, an
 * object in a code fence, or one object embedded in prose all parse; anything
 * else answers null and the caller renders the verbatim text as prose,
 * honestly. Malformed agent entries are dropped, well-formed ones kept.
 *
 * @param text everything the model streamed
 * @return the structured reading, or null when there is none
 */
export function readAnalysis(text: string): AnalysisReading | null {
  const candidate = extractJsonObject(text);
  if (candidate === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const summary = (parsed as { summary?: unknown }).summary;
  if (typeof summary !== "string" || summary.trim() === "") return null;
  const rawAgents = (parsed as { agents?: unknown }).agents;
  const agents: { id: string; reading: string }[] = [];
  if (Array.isArray(rawAgents)) {
    for (const entry of rawAgents) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as { id?: unknown }).id;
      const reading = (entry as { reading?: unknown }).reading;
      if (typeof id === "string" && typeof reading === "string") agents.push({ id, reading });
    }
  }
  return { summary, agents };
}

/** The first {...} span of the text, fences stripped — or null. */
function extractJsonObject(text: string): string | null {
  const unfenced = text.replace(/```[a-z]*\n?/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

// The translation runtime (owner 2026-07-27: "mache das übersetzungsfeature auf
// jsonl text ebene ... einmal sinnvoll übersetzen im hintergrund und dann
// überall nutzen"). Two halves live here:
//
//   1. The pure half — how a unit of the stream is cut into passages small
//      enough for a 1.7B local model, how the answers are put back together,
//      and how the NDJSON stream folds into a run.
//   2. A per-view store in the house pattern (useSyncExternalStore over a module
//      store, à la disclosure.ts / toolView.ts) that drives the run in the
//      BACKGROUND and hands every view the same translated RunEvent[].
//
// WHAT A UNIT IS is not decided here: translate/units.ts owns that, and this
// module only ever sees `{ id, kind, text }`. What IS decided here is what
// leaves the browser. Fenced code blocks are cut out of a unit and never sent —
// a mangled shell command reads like a real one, and that is worse than an
// untranslated one. They are put back verbatim when the unit is reassembled.
//
// THE RECORD SURVIVES. The store never touches the recorded stream: it holds a
// map from unit id to translated text, and the selector produces a COPY with
// the translation in it. `show: "original"` hands back the untouched array by
// identity, so the original is always one click away — this is read on other
// people's incident evidence, and a translation that replaces the record
// destroys the record.

import { useMemo, useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import { currentLang } from "./lang";
import { applyUnits, extractUnits } from "../translate/units";
import type { Unit } from "../translate/units";

/** One translatable field of the stream — translate/units.ts owns the shape. */
export type TranslationUnit = Unit;
export type UnitKind = Unit["kind"];

/** One passage's worth of prose. The server's own per-unit bound is twice this. */
export const MAX_PASSAGE_CHARS = 2000;
/** Passages one REQUEST may carry — mirrors the server's MAX_UNITS. */
export const MAX_PASSAGES_PER_REQUEST = 40;
/** Characters one REQUEST may carry — mirrors the server's MAX_TEXT_CHARS. */
export const MAX_CHARS_PER_REQUEST = 60000;

/** `code` pieces are kept as they are and never sent anywhere. */
export type PieceKind = "text" | "code";

/**
 * One piece of a unit. `before` and `after` are the untranslatable padding
 * around it — the separator the split consumed, plus the blank lines that
 * framed the passage. They exist so the pieces reassemble into the original
 * character for character, and so a TRANSLATED piece drops back into the same
 * layout: a paragraph translated without its trailing blank line would pull the
 * code fence under it up by one line.
 */
export interface UnitPiece {
  kind: PieceKind;
  text: string;
  before: string;
  after: string;
}

/** One provider call: a prose piece of a unit, with what that unit IS. */
export interface Passage {
  unitId: string;
  pieceIndex: number;
  kind: UnitKind;
  text: string;
}

/** A unit as this run will send and reassemble it. */
export interface PlannedUnit {
  id: string;
  kind: UnitKind;
  pieces: UnitPiece[];
}

/** Everything one run needs: the units to rebuild, the calls to make. */
export interface Plan {
  units: PlannedUnit[];
  passages: Passage[];
}

/** The key a passage's answer comes back under. */
export function passageKey(unitId: string, pieceIndex: number): string {
  return `${unitId}#${pieceIndex}`;
}

/**
 * Cut a unit into what may be sent and what may not. A fenced block — including
 * its fences — becomes a `code` piece; an UNTERMINATED fence stays code to the
 * end, because half a code block is still not prose. Prose over the cap is
 * broken at line ends so paragraphs survive the call.
 *
 * @param text     the unit's recorded text
 * @param maxChars the per-passage cap
 * @return the pieces in order; `joinUnit` reverses this exactly
 */
export function splitUnit(text: string, maxChars: number = MAX_PASSAGE_CHARS): UnitPiece[] {
  const pieces: UnitPiece[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  /** Every piece but the first is preceded by the newline the split consumed. */
  const push = (kind: PieceKind, body: string, glue: string): void => {
    pieces.push({ kind, text: body, before: pieces.length === 0 ? "" : glue, after: "" });
  };

  const flush = (kind: PieceKind): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n");
    buffer = [];
    if (kind === "code") {
      push(kind, joined, "\n");
      return;
    }
    for (const chunk of chunkProse(joined, maxChars)) push("text", chunk.text, chunk.glue);
  };

  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    if (fence === null && match) {
      flush("text");
      fence = match[1][0];
      buffer.push(line);
      continue;
    }
    if (fence !== null && match && match[1][0] === fence) {
      buffer.push(line);
      flush("code");
      fence = null;
      continue;
    }
    buffer.push(line);
  }
  flush(fence === null ? "text" : "code");
  return tighten(pieces);
}

/**
 * Move the blank lines that frame a prose piece out of the text and into the
 * padding. The model then gets the passage and nothing else, and the layout of
 * the unit is carried by the pieces the model never sees.
 */
function tighten(pieces: readonly UnitPiece[]): UnitPiece[] {
  return pieces.map((piece) => {
    if (piece.kind !== "text") return piece;
    const lead = /^\n+/.exec(piece.text)?.[0] ?? "";
    const core = piece.text.slice(lead.length);
    const trail = /\n+$/.exec(core)?.[0] ?? "";
    return {
      kind: "text",
      text: core.slice(0, core.length - trail.length),
      before: piece.before + lead,
      after: trail + piece.after,
    };
  });
}

/**
 * The unit put back together. A piece with no translation stays as it was
 * recorded — a blank where a sentence was would read as data loss, and mixing
 * languages inside one answer is the price of showing partial work honestly.
 *
 * @param pieces     the unit's pieces, from {@link splitUnit}
 * @param translated piece index -> translated text
 * @return the unit's text
 */
export function joinUnit(pieces: readonly UnitPiece[], translated: ReadonlyMap<number, string>): string {
  return pieces
    .map((piece, index) => piece.before + (translated.get(index) ?? piece.text) + piece.after)
    .join("");
}

/**
 * What one run will send and how it will put the answers back.
 *
 * @param units    the stream's translatable units
 * @param maxChars the per-passage cap
 * @return the plan; a unit that is only code produces no passage at all
 */
export function planTranslation(
  units: readonly TranslationUnit[],
  maxChars: number = MAX_PASSAGE_CHARS,
): Plan {
  const planned: PlannedUnit[] = [];
  const passages: Passage[] = [];
  for (const unit of units) {
    const pieces = splitUnit(unit.text, maxChars);
    planned.push({ id: unit.id, kind: unit.kind, pieces });
    pieces.forEach((piece, pieceIndex) => {
      if (piece.kind !== "text" || piece.text.trim() === "") return;
      passages.push({ unitId: unit.id, pieceIndex, kind: unit.kind, text: piece.text });
    });
  }
  return { units: planned, passages };
}

/**
 * What translating THIS stream would cost — the panel shows it before the run
 * and the run itself uses it. The one place the two agree.
 *
 * @param events the stream to translate
 * @return the plan for it
 */
export function planFor(events: readonly RunEvent[]): Plan {
  return planTranslation(extractUnits(events));
}

/**
 * The passages cut into requests the server will accept. The old panel dropped
 * everything past the bound and said so; a translation the whole app reads
 * cannot do that, so a long session becomes several requests instead. Nothing
 * is ever left behind.
 *
 * @param passages the run's calls, in order
 * @param opts     the server's per-request bounds
 * @return the batches, in order; concatenating them returns the input
 */
export function batchPassages(
  passages: readonly Passage[],
  opts: { maxPassages: number; maxChars: number },
): Passage[][] {
  const batches: Passage[][] = [];
  let current: Passage[] = [];
  let chars = 0;
  for (const passage of passages) {
    const full = current.length >= opts.maxPassages || chars + passage.text.length > opts.maxChars;
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(passage);
    chars += passage.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The POST body: the passage and what it IS, and nothing else about the session. */
export function requestBody(
  engine: Engine,
  target: string,
  batch: readonly Passage[],
): { engine: Engine; target: string; units: { kind: UnitKind; text: string }[] } {
  return {
    engine,
    target,
    units: batch.map((passage) => ({ kind: passage.kind, text: passage.text })),
  };
}

/** The meta line the server opens a run with. */
export interface TranslateMeta {
  engine: string;
  provider: string;
  model: string;
  target: string;
  units: number;
}

/** One parsed NDJSON message from the translation stream. */
export interface TranslateMessage {
  meta?: TranslateMeta;
  unit?: number;
  delta?: string;
  end?: boolean;
  error?: string;
  done?: boolean;
}

/** A run reduced from the wire, keyed by passage rather than by wire index. */
export interface RunFold {
  meta: TranslateMeta | null;
  /** passage key -> text as it streams. */
  byKey: ReadonlyMap<string, string>;
  /** passage keys that came back, translated or failed. */
  settled: ReadonlySet<string>;
  /** passage key -> why that one passage did not make it. */
  failed: ReadonlyMap<string, string>;
  finished: number;
  /** A terminal failure of the whole request. */
  fatal: string | null;
}

export const EMPTY_FOLD: RunFold = {
  meta: null,
  byKey: new Map(),
  settled: new Set(),
  failed: new Map(),
  finished: 0,
  fatal: null,
};

/**
 * Fold one wire message into the run.
 *
 * @param fold the run so far (never mutated)
 * @param msg  the parsed NDJSON message
 * @param keys the passage keys of the CURRENT request, in the order they were
 *             sent — the wire counts passages by index, the run keys them by unit
 * @return the new fold
 */
export function foldMessage(fold: RunFold, msg: TranslateMessage, keys: readonly string[]): RunFold {
  if (msg.meta) return { ...fold, meta: msg.meta };
  if (msg.done) return fold;
  if (msg.unit === undefined) {
    // A terminal error line carries no unit — the request is over.
    return msg.error !== undefined ? { ...fold, fatal: msg.error } : fold;
  }
  const key = keys[msg.unit];
  if (key === undefined) return fold; // a passage this client never sent
  if (msg.error !== undefined) {
    const failed = new Map(fold.failed);
    failed.set(key, msg.error);
    return { ...fold, failed, settled: withKey(fold.settled, key), finished: fold.finished + 1 };
  }
  if (msg.end) {
    return { ...fold, settled: withKey(fold.settled, key), finished: fold.finished + 1 };
  }
  if (msg.delta !== undefined) {
    const byKey = new Map(fold.byKey);
    byKey.set(key, (byKey.get(key) ?? "") + msg.delta);
    return { ...fold, byKey };
  }
  return fold;
}

/**
 * The units that are ready to be shown, joined.
 *
 * A unit lands only when EVERY prose piece of it came back with something. One
 * failed or empty passage keeps the whole unit in its original language: a
 * paragraph that is two thirds German and one third Ukrainian looks like the
 * record is broken, and the panel names the failure instead.
 *
 * @param plan the run's plan
 * @param fold the run so far
 * @return unit id -> translated text
 */
export function settledUnits(plan: Plan, fold: RunFold): Map<string, string> {
  const out = new Map<string, string>();
  for (const unit of plan.units) {
    const translated = new Map<number, string>();
    let complete = true;
    let prose = 0;
    unit.pieces.forEach((piece, index) => {
      if (piece.kind !== "text" || piece.text.trim() === "") return;
      prose += 1;
      const key = passageKey(unit.id, index);
      const text = fold.byKey.get(key);
      if (!fold.settled.has(key) || text === undefined || text.trim() === "") {
        complete = false;
        return;
      }
      translated.set(index, text);
    });
    if (complete && prose > 0) out.set(unit.id, joinUnit(unit.pieces, translated));
  }
  return out;
}

/**
 * The units a run could not translate, and why — the honest half of the same
 * fold. A unit reports the first reason one of its passages gave.
 *
 * @param plan the run's plan
 * @param fold the run so far
 * @return unit id -> the provider's message
 */
export function failedUnits(plan: Plan, fold: RunFold): Map<string, string> {
  const out = new Map<string, string>();
  for (const unit of plan.units) {
    for (let index = 0; index < unit.pieces.length; index++) {
      const why = fold.failed.get(passageKey(unit.id, index));
      if (why !== undefined) {
        out.set(unit.id, why);
        break;
      }
    }
  }
  return out;
}

/**
 * Incremental NDJSON splitter for this stream's message shape (explainStream's
 * twin is typed to its own wire). A non-JSON line is skipped: a proxy hiccup
 * should cost one passage, not the whole run.
 */
export function parseTranslateChunk(
  pending: string,
  chunk: string,
): { pending: string; messages: TranslateMessage[] } {
  const buf = pending + chunk;
  const lines = buf.split("\n");
  const tail = lines.pop() ?? "";
  const messages: TranslateMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as TranslateMessage);
    } catch {
      // skip the garbage line, keep the run alive
    }
  }
  return { pending: tail, messages };
}

// ---- the engines ---------------------------------------------------------

export type Engine = "local" | "cloud";

/** One engine as GET /api/translate/engines reports it. */
export interface EngineReport {
  available: boolean;
  /** no-binary | no-model | needs-key | provider-is-local — absent when available. */
  reason?: string;
  provider?: string;
  model?: string;
  label?: string;
  /** The server's own readable message (cloud, needs-key). */
  detail?: string;
}

export interface Engines {
  local: EngineReport;
  cloud: EngineReport;
}

/** Which engines this install can actually offer. A non-200 throws rather than
 *  parses: the fence answers 404 with no body, and a fabricated "available"
 *  would be exactly the failing button this endpoint exists to prevent. */
export async function fetchTranslateEngines(): Promise<Engines> {
  const res = await fetch("/api/translate/engines");
  if (!res.ok) throw new Error(`translate engines ${res.status}`);
  const engines = (await res.json()) as Engines;
  if (!engines?.local || !engines?.cloud) throw new Error("translate engines: unexpected shape");
  return engines;
}

/** The two languages this app speaks; the reader picks the one they read in. */
export const TARGETS: ReadonlyArray<{ code: Lang; name: string }> = [
  { code: "de", name: "Deutsch" },
  { code: "en", name: "English" },
];

/** The target the panel starts on: the language the chrome is already in. */
export function defaultTarget(lang: Lang): string {
  return lang;
}

// ---- the per-view store --------------------------------------------------

export type ShowMode = "original" | "translation";
export type TranslateStatus = "idle" | "running" | "done" | "stopped" | "error";

/** One session view's translation: the choices, the progress, and the result. */
export interface TranslationState {
  target: string;
  engine: Engine | null;
  /** Which text the app renders. The original is never more than a click away. */
  show: ShowMode;
  status: TranslateStatus;
  meta: TranslateMeta | null;
  /** unit id -> translated text; only units that came back whole. */
  byId: ReadonlyMap<string, string>;
  /** unit id -> why that unit is still in its original language. */
  failed: ReadonlyMap<string, string>;
  /** Provider calls this run planned, and how many have come back. */
  passages: number;
  finished: number;
  /** Units this run covers. */
  units: number;
  /** A terminal failure of the run. */
  error: string | null;
}

export function emptyTranslation(lang: Lang): TranslationState {
  return {
    target: defaultTarget(lang),
    engine: null,
    show: "translation",
    status: "idle",
    meta: null,
    byId: new Map(),
    failed: new Map(),
    passages: 0,
    finished: 0,
    units: 0,
    error: null,
  };
}

const views = new Map<string, TranslationState>();
const listeners = new Set<() => void>();
/** The abort handle of the run in flight, per view. */
const running = new Map<string, AbortController>();

/** Visible for tests, and the non-reactive read for imperative callers. */
export function translationOf(viewKey: string): TranslationState {
  const known = views.get(viewKey);
  if (known !== undefined) return known;
  // Seeded on first read so the snapshot keeps ONE identity per view — React
  // tears if getSnapshot hands back a fresh object every render.
  const seeded = emptyTranslation(currentLang());
  views.set(viewKey, seeded);
  return seeded;
}

function patch(viewKey: string, next: Partial<TranslationState>): void {
  views.set(viewKey, { ...translationOf(viewKey), ...next });
  for (const listener of listeners) listener();
}

export function setTarget(viewKey: string, target: string): void {
  patch(viewKey, { target });
}

export function setEngine(viewKey: string, engine: Engine): void {
  patch(viewKey, { engine });
}

export function setShow(viewKey: string, show: ShowMode): void {
  patch(viewKey, { show });
}

export function toggleShow(viewKey: string): void {
  patch(viewKey, { show: translationOf(viewKey).show === "translation" ? "original" : "translation" });
}

/** Forget a view's translation and go back to the record. */
export function resetTranslation(viewKey: string): void {
  // Drop the handle as well as aborting it: the run's own teardown would
  // otherwise land on this view afterwards and report a stop nobody asked for.
  running.get(viewKey)?.abort();
  running.delete(viewKey);
  const current = translationOf(viewKey);
  patch(viewKey, { ...emptyTranslation(currentLang()), target: current.target, engine: current.engine });
}

/** Stop the run in flight. What already came back stays — it is not wrong. */
export function stopTranslation(viewKey: string): void {
  running.get(viewKey)?.abort();
}

/**
 * Translate a view's stream in the background.
 *
 * The fetch lives in this module, not in the panel, so closing the sheet or
 * switching tabs does not cancel the run — only {@link stopTranslation} does.
 * Units land as they finish, and every view picks them up on the next render.
 *
 * @param viewKey the session view ("live" or a replay id)
 * @param events  the stream to translate
 */
export async function startTranslation(viewKey: string, events: readonly RunEvent[]): Promise<void> {
  const start = translationOf(viewKey);
  if (start.engine === null) return;
  const engine = start.engine;
  const target = start.target;

  const plan = planFor(events);
  const batches = batchPassages(plan.passages, {
    maxPassages: MAX_PASSAGES_PER_REQUEST,
    maxChars: MAX_CHARS_PER_REQUEST,
  });

  running.get(viewKey)?.abort();
  const controller = new AbortController();
  running.set(viewKey, controller);
  /** A run that has been superseded stops writing: the newer one owns the view. */
  const owned = (): boolean => running.get(viewKey) === controller;

  let fold = EMPTY_FOLD;
  patch(viewKey, {
    status: "running",
    show: "translation",
    meta: null,
    byId: new Map(),
    failed: new Map(),
    passages: plan.passages.length,
    finished: 0,
    units: plan.units.length,
    error: null,
  });

  /**
   * Publish what has landed. Only a settled passage can change the result, so a
   * chunk of deltas publishes nothing: every state object this writes is a
   * re-render of every view that reads the translation.
   */
  const publish = (settled: boolean): void => {
    if (!owned()) return;
    const current = translationOf(viewKey);
    if (!settled && current.meta === fold.meta && current.finished === fold.finished) return;
    patch(viewKey, {
      meta: fold.meta,
      finished: fold.finished,
      ...(settled ? { byId: settledUnits(plan, fold), failed: failedUnits(plan, fold) } : {}),
    });
  };

  try {
    for (const batch of batches) {
      const keys = batch.map((passage) => passageKey(passage.unitId, passage.pieceIndex));
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody(engine, target, batch)),
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
        const parsed = parseTranslateChunk(pending, decoder.decode(value, { stream: true }));
        pending = parsed.pending;
        let settled = false;
        for (const msg of parsed.messages) {
          fold = foldMessage(fold, msg, keys);
          if (msg.end === true || (msg.error !== undefined && msg.unit !== undefined)) settled = true;
        }
        publish(settled);
      }
      if (fold.fatal !== null) {
        publish(true);
        if (owned()) patch(viewKey, { status: "error", error: fold.fatal });
        return;
      }
    }
    publish(true);
    if (owned()) patch(viewKey, { status: "done" });
  } catch (failed) {
    publish(true);
    if (!owned()) return;
    if (controller.signal.aborted) {
      patch(viewKey, { status: "stopped" });
      return;
    }
    patch(viewKey, { status: "error", error: failed instanceof Error ? failed.message : String(failed) });
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

/** The read hook: one session view's translation state. */
export function useTranslation(viewKey: string): TranslationState {
  const read = (): TranslationState => translationOf(viewKey);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The stream every view should render.
 *
 * @param events the recorded stream
 * @param state  that view's translation state
 * @return the translated stream, or the recorded one BY IDENTITY when there is
 *         nothing to show or the reader asked for the original — identity
 *         matters, it is what keeps the downstream folds from recomputing
 */
export function translatedEvents(events: readonly RunEvent[], state: TranslationState): readonly RunEvent[] {
  if (state.show === "original") return events;
  return withTranslation(events, state);
}

/**
 * The translated stream regardless of what the toggle currently shows — what
 * the export writes, so a reader looking at the original still saves the file
 * the button promises.
 *
 * @param events the recorded stream
 * @param state  that view's translation state
 * @return the stream with every landed unit in it
 */
export function withTranslation(events: readonly RunEvent[], state: TranslationState): readonly RunEvent[] {
  if (state.byId.size === 0) return events;
  return applyUnits(events, state.byId);
}

/** The selector as a hook: the stream a view renders, memoised. */
export function useTranslatedEvents(viewKey: string, events: readonly RunEvent[]): readonly RunEvent[] {
  const state = useTranslation(viewKey);
  return useMemo(() => translatedEvents(events, state), [events, state]);
}

/** Opens or closes a markdown code fence (``` or ~~~, up to three spaces in). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function withKey(settled: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(settled);
  next.add(key);
  return next;
}

/**
 * Pack prose into chunks under the cap, breaking at line ends so paragraphs
 * survive. A single line longer than the cap is hard-split — mid-sentence hurts
 * the translation, but exceeding the wire bound would lose the passage
 * entirely. `glue` records which cut ate a newline and which ate nothing, so
 * the pieces still rejoin into the exact original.
 */
function chunkProse(text: string, maxChars: number): { text: string; glue: string }[] {
  const lines: { text: string; glue: string }[] = [];
  let current = "";
  // An accumulator that is empty and an accumulated EMPTY LINE are different
  // things; conflating them eats a blank line out of the reassembled unit.
  let started = false;
  for (const line of text.split("\n")) {
    const next = started ? `${current}\n${line}` : line;
    if (started && next.length > maxChars) {
      lines.push({ text: current, glue: "\n" });
      current = line;
    } else {
      current = next;
    }
    started = true;
  }
  lines.push({ text: current, glue: "\n" });
  return lines.flatMap((chunk) =>
    chunk.text.length > maxChars
      ? hardSplit(chunk.text, maxChars).map((part, i) => ({ text: part, glue: i === 0 ? chunk.glue : "" }))
      : [chunk],
  );
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

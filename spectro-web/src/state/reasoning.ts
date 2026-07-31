// Card 88, web half: reasoning control driven by the capability record.
// GET /api/models/capabilities?provider&model answers what one (provider,
// model) pair honestly supports — control none|toggle|effort, the legal
// levels, whether a wire-level OFF exists and up to which effort. The record
// is the ONLY truth here: no model-name list in the client, ever (the owner
// once caught a default model whose thinking the app could not show).
//
// Three parts, same seam pattern as the rest of state/*:
//   - fetchCapability: the record, cached per pair; null = unknown (a dark
//     server), which renders NOTHING — never a confident fake none-record.
//   - the pure seg math: which cells exist, which is pressed, which is greyed
//     and why, and what a click means (explicit choice / back to default).
//   - a tiny persisted store à la disclosure.ts: the choice per (provider,
//     model) pair, absence = the model default.

import { useSyncExternalStore } from "react";

export interface ReasoningCapability {
  control: "none" | "toggle" | "effort";
  /** The model reasons when the request says nothing. */
  defaultOn: boolean;
  /** An explicit wire-level OFF exists; false = never render an off state. */
  offSwitch: boolean;
  /** Legal effort values, record order; [] unless control is "effort". */
  efforts: string[];
  /** The endpoint's default level, or null (nothing to mark as default). */
  defaultEffort: string | null;
  /** OFF is legal only at/below this effort (opus-5), or null. */
  offMaxEffort: string | null;
  /** The wire field the choice spends; null when control is "none". */
  wire: string | null;
  source: string;
}

/** An explicit picker choice; mode "default" means "let the model default". */
export interface ReasoningChoice {
  mode: "on" | "off" | "default";
  effort?: string;
}

export interface SegCell {
  /** "on" / "off", or the effort token itself. */
  id: string;
  kind: "on" | "off" | "effort";
  pressed: boolean;
  disabled: boolean;
  /** Why a cell is greyed: no wire OFF at all, or the offMaxEffort cap. */
  reason?: "no-off" | "cap";
  /** The record's offMaxEffort, set with reason "cap" so the greyed reason can
   *  name the level instead of pointing at the cell itself. */
  capAt?: string;
}

const DEFAULT_CHOICE: ReasoningChoice = Object.freeze({ mode: "default" });

// ---------------------------------------------------------------- record

const CONTROLS = new Set(["none", "toggle", "effort"]);

/** The record as served, tolerantly: absent fields take the none-record's
 *  defaults; anything that is not a record at all answers null. */
export function parseCapability(raw: unknown): ReasoningCapability | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const control = typeof r.control === "string" ? r.control : "none";
  if (!CONTROLS.has(control)) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    control: control as ReasoningCapability["control"],
    defaultOn: r.defaultOn === true,
    offSwitch: r.offSwitch === true,
    efforts: Array.isArray(r.efforts) ? r.efforts.filter((e): e is string => typeof e === "string") : [],
    defaultEffort: str(r.defaultEffort),
    offMaxEffort: str(r.offMaxEffort),
    wire: str(r.wire),
    source: typeof r.source === "string" ? r.source : "static",
  };
}

// ---------------------------------------------------------------- seg math

/** The canonical ladder, for display order and the offMaxEffort comparison.
 *  Effort TOKENS are wire vocabulary, not model names — ranking them here does
 *  not re-introduce a per-model table. "none" is openai's lowest rung (their
 *  off travels as an effort value), measured against the live endpoint. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const rank = (effort: string): number => EFFORT_ORDER.indexOf(effort);

/** The record's levels in reading order (low → max) when every token is on
 *  the canonical ladder; a record with tokens we cannot rank keeps its own
 *  order — the server's order is more honest than an alphabetical guess. */
export function orderedEfforts(cap: ReasoningCapability): string[] {
  if (cap.efforts.some((e) => rank(e) < 0)) return cap.efforts;
  return [...cap.efforts].sort((a, b) => rank(a) - rank(b));
}

/** The effort the seg currently shows as active: the explicit choice, else
 *  the model default. Null = nothing marked (opt-in model, no default). */
function shownEffort(cap: ReasoningCapability, choice: ReasoningChoice): string | null {
  if (choice.mode === "off") return null;
  if (choice.mode === "on" && choice.effort !== undefined) return choice.effort;
  if (choice.mode === "default" && !cap.defaultOn) return null;
  return cap.defaultEffort;
}

/** OFF is illegal above offMaxEffort (the record's cross-field rule). Unknown
 *  tokens never block — the server validates; greying here is a courtesy. */
function offCapped(cap: ReasoningCapability, choice: ReasoningChoice): boolean {
  if (cap.offMaxEffort === null) return false;
  const shown = choice.effort ?? cap.defaultEffort;
  if (shown === null || shown === undefined) return false;
  const s = rank(shown);
  const m = rank(cap.offMaxEffort);
  return s >= 0 && m >= 0 && s > m;
}

/** The seg, derived purely from record + choice. none → no cells at all —
 *  the UI must not offer what the model cannot do. */
export function segCells(cap: ReasoningCapability, choice: ReasoningChoice): SegCell[] {
  if (cap.control === "toggle") {
    const onPressed = choice.mode === "on" || (choice.mode === "default" && cap.defaultOn);
    const offPressed = choice.mode === "off" || (choice.mode === "default" && !cap.defaultOn);
    return [
      { id: "on", kind: "on", pressed: onPressed, disabled: false },
      {
        id: "off",
        kind: "off",
        pressed: offPressed,
        disabled: !cap.offSwitch,
        ...(cap.offSwitch ? {} : { reason: "no-off" as const }),
      },
    ];
  }
  if (cap.control === "effort") {
    const active = shownEffort(cap, choice);
    const cells: SegCell[] = [];
    if (cap.offSwitch) {
      const capped = offCapped(cap, choice);
      cells.push({
        id: "off",
        kind: "off",
        pressed: choice.mode === "off",
        disabled: capped,
        ...(capped ? { reason: "cap" as const, capAt: cap.offMaxEffort ?? "" } : {}),
      });
    }
    for (const effort of orderedEfforts(cap)) {
      cells.push({ id: effort, kind: "effort", pressed: effort === active, disabled: false });
    }
    return cells;
  }
  return [];
}

/** What a cell click means: an explicit choice, or — clicking the choice that
 *  is already explicit — back to the model default (the wire's "default" mode
 *  exists exactly to clear). */
export function cellClick(
  cap: ReasoningCapability,
  choice: ReasoningChoice,
  cellId: string,
): ReasoningChoice {
  if (cellId === "off") return choice.mode === "off" ? DEFAULT_CHOICE : { mode: "off" };
  if (cellId === "on" && cap.control === "toggle") {
    return choice.mode === "on" ? DEFAULT_CHOICE : { mode: "on" };
  }
  if (choice.mode === "on" && choice.effort === cellId) return DEFAULT_CHOICE;
  return { mode: "on", effort: cellId };
}

/** For a control "none" record: whether a thinking stream will show up anyway.
 *  The record answers that even where there is nothing to switch. */
export function noneNote(cap: ReasoningCapability): "thinks" | "quiet" {
  return cap.defaultOn ? "thinks" : "quiet";
}

/**
 * The choice as it may reach the wire, clamped against the CURRENT record.
 * A stored choice outlives the record that produced it (localStorage across
 * releases, an API overlay that narrows the ladder), and the send site is a
 * different place from the seg — so the record rules here too: what the seg
 * does not offer, the client does not spend. An unknown record (null, dark
 * server) spends nothing, matching a seg that renders nothing.
 */
export function wireChoice(cap: ReasoningCapability | null, choice: ReasoningChoice): ReasoningChoice {
  if (cap === null || cap.control === "none" || choice.mode === "default") return DEFAULT_CHOICE;
  if (choice.mode === "off") return cap.offSwitch ? choice : DEFAULT_CHOICE;
  if (choice.effort === undefined) return choice;
  if (cap.control === "effort" && cap.efforts.includes(choice.effort)) return choice;
  return { mode: "on" };
}

/** The additive WS op the server understands (SpectroSocketHandler card 88). */
export function reasoningFrame(choice: ReasoningChoice): {
  type: "set_reasoning";
  mode: "on" | "off" | "default";
  effort?: string;
} {
  return {
    type: "set_reasoning",
    mode: choice.mode,
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
  };
}

// ---------------------------------------------------------------- store

const KEY = "spectroscope:reasoning";
/** Bound on remembered pairs — oldest entry falls out, a browser is not a DB. */
const MAX_ENTRIES = 64;

function readSaved(): Record<string, ReasoningChoice> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ReasoningChoice> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as { mode?: unknown; effort?: unknown };
      if (c && (c.mode === "on" || c.mode === "off")) {
        out[k] = { mode: c.mode, ...(typeof c.effort === "string" ? { effort: c.effort } : {}) };
      }
    }
    return out;
  } catch {
    return {}; // no/blocked localStorage (tests, private mode) — defaults only
  }
}

let choices: Record<string, ReasoningChoice> = readSaved();
const listeners = new Set<() => void>();

/** NUL separates the pair — a model id may carry spaces, never a NUL. */
const pairKey = (provider: string, model: string): string => `${provider}\u0000${model}`;

/** The remembered choice for a pair; absence answers the model default. */
export function choiceFor(provider: string, model: string): ReasoningChoice {
  return choices[pairKey(provider, model)] ?? DEFAULT_CHOICE;
}

/** Remembers a choice per pair. The default is not stored — it IS absence —
 *  so the map only ever carries real overrides. */
export function setReasoningChoice(provider: string, model: string, choice: ReasoningChoice): void {
  const key = pairKey(provider, model);
  const prev = choices[key];
  if (choice.mode === "default") {
    if (prev === undefined) return;
    const { [key]: _dropped, ...rest } = choices;
    choices = rest;
  } else {
    if (prev !== undefined && prev.mode === choice.mode && prev.effort === choice.effort) return;
    choices = { ...choices, [key]: choice };
    const keys = Object.keys(choices);
    if (keys.length > MAX_ENTRIES) {
      const { [keys[0]]: _oldest, ...rest } = choices;
      choices = rest;
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    /* ignore — the in-memory store still works this session */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Live view of one pair's choice (stable reference while unchanged). */
export function useReasoningChoice(provider: string, model: string): ReasoningChoice {
  return useSyncExternalStore(
    subscribe,
    () => choiceFor(provider, model),
    () => choiceFor(provider, model),
  );
}

// ---------------------------------------------------------------- fetch

let activeFetch: typeof fetch = (...args) => window.fetch(...args);
const capCache = new Map<string, ReasoningCapability | null>();

/**
 * The capability record for one pair, cached for the page's lifetime (the
 * table is static per server; live-discovery providers answer stable records
 * too). Resolves null when the server is dark or answers garbage — callers
 * render nothing then, never a fake none-record.
 */
export async function fetchCapability(provider: string, model: string): Promise<ReasoningCapability | null> {
  const key = pairKey(provider, model);
  const hit = capCache.get(key);
  if (hit !== undefined) return hit;
  let cap: ReasoningCapability | null = null;
  try {
    const res = await activeFetch(
      `/api/models/capabilities?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    );
    if (res.ok) cap = parseCapability(await res.json());
  } catch {
    cap = null;
  }
  // Only a record that ARRIVED is cached. A failed probe stays uncached, so a
  // server that finishes booting is asked again on the next mount instead of
  // hiding the control until a page reload.
  if (cap !== null) capCache.set(key, cap);
  return cap;
}

/** Test-only: inject a fake fetch and clear the caches; null restores. */
export function __setTestHooks(hooks: { fetchFn?: typeof fetch } | null): void {
  activeFetch = hooks?.fetchFn ?? ((...args) => window.fetch(...args));
  capCache.clear();
}

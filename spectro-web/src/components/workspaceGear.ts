// Pure logic for the composer's workspace gear (settings-productization Task
// 16): what the popover shows, given the resolved settings view, the
// session's workspace announcement and the LIVE permission mode. The .tsx
// stays thin — it only wires DOM events to these decisions.
//
// Rules read from view.layers.project?.autoApprove — the PROJECT file's OWN
// list, not view.effective.autoApprove (the merged-across-scopes value):
// that is the exact list a PUT to the project scope rewrites, so reading
// anything else would silently diverge from what add/remove actually do.

import type { Origin, SettingsView } from "../state/serverSettings";
import { workspaceBasename } from "../workspace/paths";
import { PROVIDERS } from "./providerPickerMode";
import { IMAGE_MODELS, imageModelOptions } from "./imageModels";

export interface GearModel {
  /** A real (configured) workspace, or the per-session temp folder? Gates
   *  the always-allow section — there is no project file to write to for an
   *  unconfigured session (fetchSettings 404s for it). */
  pinned: boolean;
  /** Basename of the workspace path, for the popover title; "" before the
   *  first workspace_info frame. */
  workspaceName: string;
  /** The effective permission mode — always the LIVE value (the socket's
   *  permission_mode_info frame), never the settings file's: the rest of the
   *  UI already treats the frame as wire truth, and a mode switch applies
   *  live even for an unpinned session that cannot persist it. */
  mode: string;
  /** The project scope's own always-allow rules; [] when unpinned (nothing
   *  to persist to) or while the view has not loaded (yet). */
  rules: string[];
  /** null while loading, or for an unpinned session (the settings fetch 404s). */
  view: SettingsView | null;
}

/** The three permission modes, in the order the listbox presents them. */
export const MODES: { id: "ask" | "auto" | "readonly" }[] = [
  { id: "ask" },
  { id: "auto" },
  { id: "readonly" },
];

/** The project scope's own autoApprove list, defensively narrowed — a
 *  malformed or absent field (an unpinned session, a view mid-load) reads as
 *  no rules rather than throwing. */
function projectRules(view: SettingsView | null): string[] {
  const raw = view?.layers.project?.autoApprove;
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
}

export function buildGearModel(
  view: SettingsView | null,
  // Both fields are absent on the connect-time announcement, which names a
  // prospective folder without minting a session or creating anything.
  workspaceInfo: { sessionId?: string; path?: string; configured: boolean } | null,
  liveMode: string,
): GearModel {
  const pinned = workspaceInfo?.configured === true;
  return {
    pinned,
    workspaceName: workspaceInfo?.path !== undefined ? workspaceBasename(workspaceInfo.path) : "",
    mode: liveMode,
    rules: pinned ? projectRules(view) : [],
    view,
  };
}

/** Adds `rule` to `rules` — trimmed, deduped, blanks rejected. Returns the
 *  SAME array reference when nothing changes (blank input, an existing
 *  rule), so a caller can skip firing a no-op write by comparing the result. */
export function rulesWith(rules: string[], rule: string): string[] {
  const trimmed = rule.trim();
  if (trimmed === "" || rules.includes(trimmed)) return rules;
  return [...rules, trimmed];
}

/** Removes `rule` from `rules` (exact match). */
export function rulesWithout(rules: string[], rule: string): string[] {
  return rules.filter((r) => r !== rule);
}

/** How one overridable key is edited and checked.
 *
 *  `enum` means the legal set is CLOSED and knowable from source — the
 *  server refuses anything outside it (SettingsWriter#checkKnownValue), so
 *  the UI may present it as a dropdown and refuse the rest up front.
 *  `text` is the honest opposite: nobody here knows the legal set (a model
 *  id belongs to whichever backend is configured, a baseUrl to whatever is
 *  listening, an sttModel to whatever whisper.cpp file exists on this disk),
 *  so it stays free text and the only check is "not blank". A `text` key
 *  must never grow a dropdown of guesses — a wrong closed set is worse than
 *  no set, because it hides values that actually work. */
export type OverrideKind = "enum" | "boolean" | "number" | "text";

/** One overridable key's editing contract — see {@link OverrideKind}.
 *
 *  @property field   the settings key, as SpectroConfig names it
 *  @property kind    which editor and which check apply
 *  @property options the CLOSED legal set for `enum`; always [] otherwise
 *  @property min     inclusive floor for `number`; null when no floor is
 *                    derivable from the engine's own behaviour
 *  @property max     inclusive ceiling for `number`; null throughout today —
 *                    no source names an upper limit for either number, and a
 *                    made-up one would refuse a value the engine accepts
 *  @property descKey the dict key of this field's one-line description */
export interface OverrideSpec {
  field: string;
  kind: OverrideKind;
  options: string[];
  min: number | null;
  max: number | null;
  descKey: string;
}

/** Builds one spec, filling the shape's defaults so each entry below states
 *  only what is true of it. */
function spec(
  field: string,
  kind: OverrideKind,
  extra: { options?: string[]; min?: number | null } = {},
): OverrideSpec {
  return {
    field,
    kind,
    options: extra.options ?? [],
    min: extra.min ?? null,
    max: null,
    descKey: `wsg.local.desc.${field}`,
  };
}

/** The session-scoped scalar fields a machine-local override (Task 17) may
 *  set, in the order the field dropdown lists them. Deliberately NOT here:
 *  `workspace`/`logLevel` (process-globals, USER-scope only —
 *  SettingsWriter's own rule), `permissionMode`/`autoApprove` (this
 *  popover's own mode listbox and rules list, both PROJECT-scoped) and
 *  `mcpServers`/`hooks` (their own JSON editors below, also PROJECT-scoped).
 *  `chromeBinary` stays a USER-only setting on the Settings page — a
 *  machine-wide tool path, not something worth overriding per session.
 *
 *  Both closed sets are IMPORTED, never re-typed: `PROVIDERS` is the same
 *  list the picker and the Settings page offer (and matches the server's
 *  KNOWN_PROVIDERS), `IMAGE_MODELS`' keys are the same two image backends —
 *  a second copy here would drift the day a provider is added and refuse a
 *  value the server happily takes. */
const OVERRIDE_SPECS: OverrideSpec[] = [
  spec("provider", "enum", { options: [...PROVIDERS] }),
  spec("model", "text"),
  spec("baseUrl", "text"),
  spec("thinking", "boolean"),
  spec("imageProvider", "enum", { options: Object.keys(IMAGE_MODELS) }),
  spec("imageModel", "text"),
  // RetryPolicy.from does Math.max(0, maxRetries): a negative is silently the
  // same as 0, so it is a typo worth naming rather than a setting.
  spec("maxRetries", "number", { min: 0 }),
  spec("promptCaching", "boolean"),
  // Compaction.maybeCompact returns early only while lastInputTokens <
  // threshold. At 0 nothing is ever below it, so every turn — including the
  // very first, on an empty context — would compact.
  spec("compactionThreshold", "number", { min: 1 }),
  spec("sttModel", "text"),
];

export function overridableFields(): string[] {
  return OVERRIDE_SPECS.map((s) => s.field);
}

/** The spec for `field`. An unknown key (a settings.local.json edited by hand
 *  outside this popover, a field this build does not know) reads as free
 *  text rather than throwing — the row still shows its current value, and
 *  the server's own validation stays the backstop. */
export function overrideSpec(field: string): OverrideSpec {
  return OVERRIDE_SPECS.find((s) => s.field === field) ?? spec(field, "text");
}

/** What the popover must know before anyone edits `field`: what its value IS
 *  right now, which layer of the fold supplied it, and whether the local
 *  scope is already the one speaking.
 *
 *  Every part comes straight from GET /api/settings — the server resolves the
 *  same ascending chain SpectroConfig folds (env < user < launch-dir <
 *  workspace project < workspace local < flags) and answers `effective` plus
 *  a per-field {@link Origin}. Nothing here re-derives precedence: a UI that
 *  guessed which layer won would be wrong the first time someone exported a
 *  SPECTRO_* variable. */
export interface OverrideSupport {
  field: string;
  spec: OverrideSpec;
  /** The value in force this moment; null when the whole fold leaves it
   *  unset (imageModel/sttModel default to null) or the view has not loaded. */
  effective: unknown;
  /** Which layer won, and which lower ones it shadows; undefined when the
   *  view carries no origin for this field. */
  origin: Origin | undefined;
  /** True when the LOCAL file itself sets the field — then `effective` IS
   *  the override, and there is nothing left for an override to beat. */
  setLocally: boolean;
  /** Known-good values for a `text` key, offered as completions rather than
   *  a constraint; [] when none are known. */
  suggestions: string[];
}

/** Known-good completions for a free-text key. Only imageModel has any: the
 *  image endpoints take an arbitrary model string, but these are the ids
 *  each backend is known to serve, and which set applies depends on the
 *  imageProvider currently in force — hence the view, not the static spec. */
function suggestionsFor(field: string, view: SettingsView | null): string[] {
  if (field !== "imageModel") return [];
  const provider = view?.effective.imageProvider;
  return imageModelOptions(typeof provider === "string" ? provider : "", "");
}

export function overrideSupport(field: string, view: SettingsView | null): OverrideSupport {
  const value = view?.effective[field];
  const local = view?.layers.local;
  return {
    field,
    spec: overrideSpec(field),
    effective: value === undefined ? null : value,
    origin: view?.origins[field],
    setLocally: local !== undefined && Object.prototype.hasOwnProperty.call(local, field),
    suggestions: suggestionsFor(field, view),
  };
}

/** Renders a settings value for the popover. Every value this UI itself
 *  writes is one of the primitives `parseLocalOverrideValue` produces; the
 *  object/array branch is a defensive fallback for a settings.local.json
 *  edited by hand outside this popover. A null (an unset field) is the
 *  caller's business — it answers "" so the caller can say "not set" in the
 *  reader's own language instead of showing the word "null". */
export function formatOverrideValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Parses one of the popover's raw-JSON editor blocks (mcpServers/hooks) —
 *  the first validation net. A syntax error answers a readable message
 *  (`JSON.parse`'s own, which already names the position) instead of
 *  throwing, so the caller shows it inline; the server's own schema check
 *  (`SettingsWriter#patch`) is the second net for a value that parses
 *  but does not bind (e.g. a malformed server block). */
export function parseBlockJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A refusal, as a dict key plus its interpolation parameters rather than a
 *  finished sentence: the popover reads in whichever language the app is set
 *  to, and a message baked in English here could not follow it. Every
 *  parameter is already a string so the caller can hand the pair straight to
 *  `t(lang, key, params)`. */
export interface OverrideProblem {
  key: string;
  params: Record<string, string>;
}

function refuse(key: string, params: Record<string, string>): { ok: false; problem: OverrideProblem } {
  return { ok: false, problem: { key, params } };
}

/** Parses the composer gear's override value input for `field`, per its
 *  {@link OverrideSpec}. Every branch refuses garbage by NAMING what is
 *  wrong with it rather than coercing: a blank value never passes; "5.7" is
 *  not a whole number; "ture" is not a boolean; "gpt5" is not one of the
 *  seven providers. A typo silently coerced would write or delete something
 *  nobody asked for — NaN serializes as `null`, and a null-valued PUT
 *  REMOVES the key per `SettingsWriter#patch`'s null-removes contract, while
 *  a non-"true" boolean would quietly become `false`.
 *
 *  This is the first net only. The server re-checks every one of these
 *  (SettingsWriter#validate) and owns the checks no client can make — that
 *  the file still binds as a whole afterwards. */
export function parseLocalOverrideValue(
  field: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; problem: OverrideProblem } {
  const trimmed = raw.trim();
  const { kind, options, min, max } = overrideSpec(field);
  if (trimmed === "") {
    return refuse("wsg.local.err.blank", { field });
  }
  switch (kind) {
    case "number": {
      const n = Number(trimmed);
      if (!Number.isInteger(n)) {
        return refuse("wsg.local.err.int", { value: trimmed });
      }
      if (min !== null && n < min) {
        return refuse("wsg.local.err.min", { value: trimmed, min: String(min) });
      }
      if (max !== null && n > max) {
        return refuse("wsg.local.err.max", { value: trimmed, max: String(max) });
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        return refuse("wsg.local.err.bool", { value: trimmed });
      }
      return { ok: true, value: lower === "true" };
    }
    case "enum": {
      if (!options.includes(trimmed)) {
        return refuse("wsg.local.err.enum", { value: trimmed, allowed: options.join(", ") });
      }
      return { ok: true, value: trimmed };
    }
    default:
      return { ok: true, value: trimmed };
  }
}

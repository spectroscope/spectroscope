// Pure logic for the composer's workspace gear (settings-productization Task
// 16): what the popover shows, given the resolved settings view, the
// session's workspace announcement and the LIVE permission mode. The .tsx
// stays thin — it only wires DOM events to these decisions.
//
// Rules read from view.layers.project?.autoApprove — the PROJECT file's OWN
// list, not view.effective.autoApprove (the merged-across-scopes value):
// that is the exact list a PUT to the project scope rewrites, so reading
// anything else would silently diverge from what add/remove actually do.

import type { SettingsView } from "../state/serverSettings";
import { workspaceBasename } from "../workspace/paths";

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
  workspaceInfo: { sessionId: string; path: string; configured: boolean } | null,
  liveMode: string,
): GearModel {
  const pinned = workspaceInfo?.configured === true;
  return {
    pinned,
    workspaceName: workspaceInfo !== null ? workspaceBasename(workspaceInfo.path) : "",
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

/** The session-scoped scalar fields a machine-local override (Task 17) may
 *  set. Deliberately NOT here: `workspace`/`logLevel` (process-globals,
 *  USER-scope only — SettingsWriter's own rule), `permissionMode`/
 *  `autoApprove` (this popover's own mode listbox and rules list, both
 *  PROJECT-scoped) and `mcpServers`/`hooks` (their own JSON editors below,
 *  also PROJECT-scoped). `chromeBinary` stays a USER-only setting on the
 *  Settings page — a machine-wide tool path, not something worth overriding
 *  per session. */
export function overridableFields(): string[] {
  return [
    "provider",
    "model",
    "baseUrl",
    "thinking",
    "imageProvider",
    "imageModel",
    "maxRetries",
    "promptCaching",
    "compactionThreshold",
    "sttModel",
  ];
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

/** Numeric local-override fields — parsed as whole numbers, not strings. */
const NUMERIC_OVERRIDE_FIELDS = new Set(["maxRetries", "compactionThreshold"]);
/** Boolean local-override fields — accepted STRICTLY as "true"/"false"
 *  (case-insensitive), everything else refused. */
const BOOLEAN_OVERRIDE_FIELDS = new Set(["thinking", "promptCaching"]);

/** Parses the composer gear's "+ override" value input for `field`, per its
 *  known shape: `NUMERIC_OVERRIDE_FIELDS` as whole numbers,
 *  `BOOLEAN_OVERRIDE_FIELDS` strictly as true/false, every other overridable
 *  field as the plain trimmed string. Every branch refuses garbage with a
 *  readable error rather than coercing: a blank value never passes; "5.7" is
 *  not a whole number; "ture" is not a boolean — a typo silently coerced
 *  (NaN serializes as `null`, and a null-valued PUT REMOVES the field per
 *  `SettingsWriter#patch`'s null-removes contract; a non-"true" boolean
 *  would silently become `false`) would write or delete something the user
 *  never asked for. */
export function parseLocalOverrideValue(
  field: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (NUMERIC_OVERRIDE_FIELDS.has(field)) {
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(n)) {
      return { ok: false, error: `"${trimmed}" is not a whole number` };
    }
    return { ok: true, value: n };
  }
  if (BOOLEAN_OVERRIDE_FIELDS.has(field)) {
    const lower = trimmed.toLowerCase();
    if (lower !== "true" && lower !== "false") {
      return { ok: false, error: `"${trimmed}" is neither true nor false` };
    }
    return { ok: true, value: lower === "true" };
  }
  if (trimmed === "") {
    return { ok: false, error: "value must not be blank" };
  }
  return { ok: true, value: trimmed };
}

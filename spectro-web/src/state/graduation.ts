// One-shot migration off the two retired localStorage stores (sessionDefaults,
// lastWorkspace — see the settings-productization plan): the server now
// builds every connection's agent straight from the user's settings
// (~/.spectro/settings.json), so a browser's leftover localStorage state is
// dead weight unless it graduates into that file. This module reads whatever
// is still sitting there, folds it into one patch the Settings page can hand
// to `putSettings("user", …)` verbatim, and clears both keys once the user
// picks adopt or discard in the graduation dialog.
//
// Same seam pattern as the rest of state/*: real localStorage by default,
// injectable for the test suite (plain Node, no jsdom) — but keyed by the
// caller (get/remove take the key), since this module reads two independent
// legacy keys rather than owning one of its own.

export const LEGACY_SESSION_DEFAULTS_KEY = "forge:sessionDefaults";
export const LEGACY_LAST_WORKSPACE_KEY = "forge:lastWorkspace";

/** A flat patch of whatever legacy state a browser still carries — every
 *  field optional, shaped to ride straight into `putSettings("user", …)`. */
export interface LegacyDefaults {
  provider?: string;
  model?: string;
  thinking?: boolean;
  imageProvider?: string;
  workspace?: string;
}

let storageGet: (key: string) => string | null = (key) => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};
let storageRemove: (key: string) => void = (key) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* storage blocked (private mode) — nothing was stuck there anyway */
  }
};

/** Parse-safe read of the old sessionDefaults blob — the exact field rules
 *  the retired reader used: garbage JSON or a wrong-typed field is dropped
 *  rather than surfaced. */
function readLegacySessionDefaults(): Omit<LegacyDefaults, "workspace"> {
  try {
    const raw = storageGet(LEGACY_SESSION_DEFAULTS_KEY);
    if (raw === null) return {};
    const p = JSON.parse(raw) as Partial<LegacyDefaults>;
    const out: Omit<LegacyDefaults, "workspace"> = {};
    if (typeof p.provider === "string" && p.provider !== "") out.provider = p.provider;
    if (typeof p.model === "string" && p.model !== "") out.model = p.model;
    if (typeof p.thinking === "boolean") out.thinking = p.thinking;
    if (typeof p.imageProvider === "string" && p.imageProvider !== "") out.imageProvider = p.imageProvider;
    return out;
  } catch {
    return {};
  }
}

/** Collects both legacy keys into one patch; `null` when a browser carries
 *  neither field (a fresh install, or one that already graduated) — an empty
 *  object plus no workspace is the same "nothing to offer" case. */
export function readLegacyLocalStorage(): LegacyDefaults | null {
  const defaults = readLegacySessionDefaults();
  const rawWorkspace = storageGet(LEGACY_LAST_WORKSPACE_KEY);
  const workspace = rawWorkspace !== null && rawWorkspace.trim() !== "" ? rawWorkspace : undefined;
  const out: LegacyDefaults = { ...defaults, ...(workspace !== undefined ? { workspace } : {}) };
  return Object.keys(out).length > 0 ? out : null;
}

/** Forgets both legacy keys — called once the graduation banner is resolved,
 *  whether the user adopted the patch or discarded it. */
export function clearLegacyLocalStorage(): void {
  storageRemove(LEGACY_SESSION_DEFAULTS_KEY);
  storageRemove(LEGACY_LAST_WORKSPACE_KEY);
}

/** Test-only: inject in-memory storage (the suite has no jsdom). */
export function __setTestHooks(hooks: {
  get?: (key: string) => string | null;
  remove?: (key: string) => void;
}): void {
  if (hooks.get) storageGet = hooks.get;
  if (hooks.remove) storageRemove = hooks.remove;
}

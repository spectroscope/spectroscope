// The settings API client (settings-productization Task 13): a thin wrapper
// over GET /api/settings and PUT /api/settings/{user|project|local} — the
// read side (Tasks 8/9, SettingsController#settings) answers all 17
// SpectroConfig fields alongside per-field provenance (which layer won, which
// lower layers it shadows), the raw non-empty layers, the concrete settings
// file paths and the resolved workspace; the write side (Tasks 9/10) applies
// a schema-validated partial patch to one scope and answers the fresh view.
// The Settings page (Task 13's SettingsPanel rewire) reads this for
// everything except design/effects/language, which stay browser-local.
//
// Same seam pattern as the rest of state/*: a real fetch by default,
// injectable for the test suite. The default calls `window.fetch(...)` as a
// METHOD (not a detached reference) — a bare `const f = window.fetch; f()`
// throws "Illegal invocation" in real browsers because Fetch's receiver must
// stay bound to window.

import { t, type Lang } from "../i18n/i18n";

/** Where one resolved field's value came from — mirrors SpectroConfig.Origin.
 *  `winner` is the layer name that supplied the effective value ("defaults"
 *  when no scope set it at all); `shadowed` lists every lower layer that also
 *  set the field but lost, highest (closest to the winner) first. */
export interface Origin {
  winner: string;
  shadowed: string[];
}

/** The settings API's read shape (GET /api/settings), verbatim — see
 *  SettingsController#settings on the server. */
export interface SettingsView {
  /** All 17 SpectroConfig fields, resolved across every layer; nulls included. */
  effective: Record<string, unknown>;
  /** Per-field provenance, keyed by field name. */
  origins: Record<string, Origin>;
  /** Each non-empty scope's own settings, as raw JSON; an untouched scope is absent. */
  layers: Record<string, Record<string, unknown>>;
  /** The concrete settings file paths for this view, keyed by scope name. */
  files: Record<string, string>;
  /** The resolved workspace directory, or null in the process-moment view. */
  workspace: string | null;
}

let activeFetch: typeof fetch = (...args) => window.fetch(...args);

/** Reads the server's readable reason off a non-ok response. Spring's error
 *  JSON carries a ResponseStatusException's reason under `message`; when
 *  that key is missing (or the body isn't JSON at all), falls back to a
 *  plain HTTP status line rather than surfacing a confusing parse error. */
async function readableError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { message?: string };
    if (typeof body.message === "string" && body.message !== "") {
      return new Error(body.message);
    }
  } catch {
    /* body wasn't JSON at all — fall through to the status line */
  }
  return new Error(`HTTP ${res.status}`);
}

/** `GET /api/settings[?session=]` — the process-moment view without a
 *  session (no workspace scopes join the chain, `workspace` answers null),
 *  the session-moment view (that session's own project/local settings
 *  joined) with one. */
export async function fetchSettings(session?: string): Promise<SettingsView> {
  const url = session ? `/api/settings?session=${encodeURIComponent(session)}` : "/api/settings";
  const res = await activeFetch(url);
  if (!res.ok) throw await readableError(res);
  return (await res.json()) as SettingsView;
}

/** `PUT /api/settings/{scope}[?session=]` — a flat partial patch; a
 *  `null`-valued entry removes that key. `project`/`local` need a session
 *  (the endpoint resolves it to a workspace and refuses without one); `user`
 *  ignores one if given. Answers the fresh SettingsView on success, throws
 *  the server's readable validation message on a 400. */
export async function putSettings(
  scope: "user" | "project" | "local",
  patch: Record<string, unknown>,
  session?: string,
): Promise<SettingsView> {
  const base = `/api/settings/${scope}`;
  const url = session ? `${base}?session=${encodeURIComponent(session)}` : base;
  const res = await activeFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await readableError(res);
  return (await res.json()) as SettingsView;
}

/** Layer names as they appear in an Origin's `winner`/`shadowed`, mapped to
 *  their bilingual dict key — mirrors SpectroConfig's own scope names exactly
 *  (env, user, launch-dir, project, local, flags). */
const LAYER_KEY: Record<string, string> = {
  env: "set.layer.env",
  user: "set.layer.user",
  "launch-dir": "set.layer.launchDir",
  project: "set.layer.project",
  local: "set.layer.local",
  flags: "set.layer.flags",
};

/** A layer's display name in `lang`; an unrecognized layer name (should not
 *  happen against a real server) shows itself verbatim rather than blank. */
function layerLabel(name: string, lang: Lang): string {
  const key = LAYER_KEY[name];
  return key ? t(lang, key) : name;
}

/** Renders an Origin as the settings page's provenance line, e.g.
 *  "from user settings · shadows env" ("aus User-Settings · überschattet
 *  env" in the de locale), or just "default" when no scope overrides the
 *  built-in value. An absent origin (a field the view doesn't carry)
 *  renders as "". */
export function originLabel(origin: Origin | undefined, lang: Lang): string {
  if (!origin) return "";
  if (origin.winner === "defaults") return t(lang, "set.originDefault");
  const base = t(lang, "set.originFrom", { layer: layerLabel(origin.winner, lang) });
  if (origin.shadowed.length === 0) return base;
  const layers = origin.shadowed.map((name) => layerLabel(name, lang)).join(", ");
  return base + t(lang, "set.originShadows", { layers });
}

/** Test-only: inject a fake `fetch` (no network, no real files touched);
 *  pass `null` to restore the real `window.fetch`. */
export function __setTestHooks(hooks: { fetchFn?: typeof fetch } | null): void {
  activeFetch = hooks?.fetchFn ?? ((...args) => window.fetch(...args));
}

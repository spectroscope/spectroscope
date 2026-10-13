// Card 585: the fleet hub in words. The server decides everything (which port,
// whether a value is allowed, why the hub is off) and sends a note code; this
// file only turns that answer into a sentence, EN and DE. No port rule lives
// here, so the two sides cannot disagree about one.

import { t, type Lang } from "../i18n/i18n";

/** The port an empty field means, and what the field shows before anything is saved. */
export const HUB_DEFAULT_PORT = "7700";

/** The `hub` block of GET /api/fleet. */
export interface HubState {
  /** SPECTRO_HUB_ENABLED as the server read it, null when not set. */
  enabledSetting: string | null;
  /** SPECTRO_HUB_PORT as the server read it, null when not set. */
  portSetting: string | null;
  on: boolean;
  /** The port the hub listens on, null when it is off. */
  port: number | null;
  /** Where the server started its walk for a free port. */
  pickFrom: number;
  /** Why the hub differs from what was written, e.g. "bind-failed"; null when it does not. */
  note: string | null;
  /** The bind error in the system's words, or null. */
  reason: string | null;
  /** The server's own English sentence. */
  message: string;
}

/** What the port field does with a typed value. */
export type PortStep = { kind: "save" } | { kind: "refused"; key: string } | { kind: "inUse"; port: number };

/**
 * The sentence the fleet settings show about the hub.
 *
 * @param hub the roster's hub block
 * @param lang the reader's language
 * @returns one plain sentence
 */
export function hubStatusText(hub: HubState, lang: Lang): string {
  const written = hub.portSetting ?? "";
  const port = hub.port ?? "";
  switch (hub.note) {
    case null:
      return hub.on ? t(lang, "hub.on", { port }) : t(lang, "hub.off");
    case "port-privileged":
      return t(lang, "hub.note.privileged", { written, port });
    case "port-invalid":
      return t(lang, "hub.note.invalid", { written, port });
    case "default-taken":
      return t(lang, "hub.note.defaultTaken", { from: hub.pickFrom, port });
    case "bind-failed":
      return t(lang, "hub.note.bindFailed", { written, reason: hub.reason ?? "?" });
    case "no-free-port":
      return t(lang, "hub.note.noFreePort", { from: hub.pickFrom });
    case "enabled-unreadable":
      return t(lang, "hub.note.enabledUnreadable", { value: hub.enabledSetting ?? "" });
    case "port-app-range":
      return t(lang, "hub.note.appRange", { written, port });
    case "port-server":
      return t(lang, "hub.note.serverPort", { written, port });
    case "setting-unreadable":
      return t(lang, "hub.note.settingUnreadable", { reason: hub.reason ?? "?" });
    default:
      return hub.message; // a note this build does not know yet: the server's words
  }
}

/**
 * The doctor row: state, port in use, both settings, and the sentence when
 * the hub is not what was written.
 *
 * @param hub the roster's hub block, null while loading, "failed" when unreadable
 * @param lang the reader's language
 * @returns the row's verdict and value
 */
export function hubDoctorRow(
  hub: HubState | null | "failed",
  lang: Lang,
): { verdict: "ok" | "warn" | "error"; value: string } {
  if (hub === "failed") return { verdict: "error", value: t(lang, "doc.unreachable") };
  if (hub === null) return { verdict: "ok", value: "…" };
  const state =
    hub.on && hub.port !== null ? t(lang, "doc.hubOn", { port: hub.port }) : t(lang, "doc.hubOff");
  const unset = t(lang, "hub.unset");
  const settings =
    `SPECTRO_HUB_ENABLED=${hub.enabledSetting ?? unset}` + ` · SPECTRO_HUB_PORT=${hub.portSetting ?? unset}`;
  if (hub.note === null) return { verdict: "ok", value: `${state} · ${settings}` };
  return { verdict: "warn", value: `${state} · ${settings} · ${hubStatusText(hub, lang)}` };
}

/**
 * Asks the server about a typed hub port before it is saved: a port the hub
 * may not take is refused with the server's reason, a port in use is named.
 * A blank field needs no question, it means the default.
 *
 * @param value the typed port
 * @param fetchFn the fetch to use (tests pass a fake)
 * @returns what the field does next
 */
export async function checkHubPort(value: string, fetchFn: typeof fetch = fetch): Promise<PortStep> {
  const typed = value.trim();
  if (typed === "") return { kind: "save" };
  let res: Response;
  try {
    res = await fetchFn(`/api/fleet/port-check?port=${encodeURIComponent(typed)}`);
  } catch {
    return { kind: "save" }; // no answer: the save itself still validates
  }
  const body = (await res.json().catch(() => ({}))) as { reason?: string; port?: number; free?: boolean };
  if (res.status === 400) return { kind: "refused", key: `hub.refuse.${body.reason ?? "not-a-port"}` };
  if (res.ok && body.free === false) return { kind: "inUse", port: body.port ?? Number(typed) };
  return { kind: "save" };
}

/** What GET /api/settings/env answers: one entry per settable name. */
export type SettingsState = Record<
  string,
  { value: string; fromEnvironment: boolean; effective?: boolean; default?: string }
>;

/** The end of one save: whether it went through, why not, and the settings read back. */
export interface SaveResult {
  ok: boolean;
  /** The i18n key of the server's refusal, when it refused. */
  refusedKey: string | null;
  /** The settings as the server reads them after the save, null when that read failed. */
  settings: SettingsState | null;
}

async function post(name: string, value: string, fetchFn: typeof fetch): Promise<string | null | "failed"> {
  try {
    const res = await fetchFn("/api/settings/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    return body.reason ? `hub.refuse.${body.reason}` : "failed";
  } catch {
    return "failed";
  }
}

async function reread(fetchFn: typeof fetch): Promise<SettingsState | null> {
  try {
    const res = await fetchFn("/api/settings/env");
    return res.ok ? ((await res.json()) as SettingsState) : null;
  } catch {
    return null;
  }
}

/**
 * Saves one setting, then reads the settings again, so the screen shows what
 * the file now says (review D4).
 *
 * @param name the setting
 * @param value its new value
 * @param fetchFn the fetch to use (tests pass a fake)
 * @returns whether it was saved, and the settings read back
 */
export async function saveSetting(
  name: string,
  value: string,
  fetchFn: typeof fetch = fetch,
): Promise<SaveResult> {
  const refused = await post(name, value, fetchFn);
  if (refused !== null)
    return { ok: false, refusedKey: refused === "failed" ? null : refused, settings: null };
  return { ok: true, refusedKey: null, settings: await reread(fetchFn) };
}

/**
 * Saves the hub port together with the switch as the screen shows it, then
 * reads the settings again. Without the switch in the file, a port alone turns
 * the hub on at the next start while the switch on screen still said off
 * (review D4). A switch the environment holds is left alone.
 *
 * @param port the port as typed
 * @param settings the settings the screen shows
 * @param fetchFn the fetch to use (tests pass a fake)
 * @returns whether the port was saved, and the settings read back
 */
export async function saveHubPort(
  port: string,
  settings: SettingsState,
  fetchFn: typeof fetch = fetch,
): Promise<SaveResult> {
  const refused = await post("SPECTRO_HUB_PORT", port, fetchFn);
  if (refused !== null)
    return { ok: false, refusedKey: refused === "failed" ? null : refused, settings: null };
  const enabled = settings["SPECTRO_HUB_ENABLED"];
  if (enabled?.fromEnvironment !== true) {
    const shownOn = enabled?.effective ?? (enabled?.value ?? "").toLowerCase() === "true";
    await post("SPECTRO_HUB_ENABLED", shownOn ? "true" : "false", fetchFn);
  }
  return { ok: true, refusedKey: null, settings: await reread(fetchFn) };
}

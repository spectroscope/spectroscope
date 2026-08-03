// Card 121: opening Settings must never write. The model auto-pick persists
// through putSettings, so it is a write, and the panel used to run it as a
// side effect of rendering — open the page with a configured model absent
// from the provider's fetched list and ~/.spectro/settings.json flipped to
// the list's first entry. This module is the extracted decision: WHY the
// chooser is showing its provider decides whether the snap may run at all.

/** How the settings model chooser came to show its current provider.
 *  "open" — the panel rendered whatever was configured; the operator is
 *  looking. "gesture" — the operator changed the provider in the panel;
 *  the operator is choosing. */
export type SettingsChooserCause = "open" | "gesture";

/**
 * Whether the settings chooser may auto-pick (and therefore persist) once the
 * provider's model list resolves. Only a real gesture may write: switching to
 * a local backend legitimately snaps a carried-over cloud model to one that is
 * actually installed, but merely opening the page must leave settings.json
 * byte-identical.
 */
export function settingsMayAutoPick(cause: SettingsChooserCause): boolean {
  return cause === "gesture";
}

/**
 * Whether a configured model should be marked as not offered by the provider:
 * a real fetched list that does not carry it. An empty list proves nothing
 * (no key, backend down), so it never marks — and per the card it must never
 * cause a write either.
 */
export function modelAbsentFromList(model: string, models: string[]): boolean {
  return model !== "" && models.length > 0 && !models.includes(model);
}

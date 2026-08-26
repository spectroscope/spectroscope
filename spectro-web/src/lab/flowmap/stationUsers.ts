// Who is using an OS station right now. Owner call, 2026-08-26: an active
// station always says WHICH agent is on it — "main", or the worker's name.
//
// The order is the fold's own resolution order (main first, then children in
// spawn order) — the FIRST entry is the occupant whose content the station
// shows (sceneToFlow resolves the occupant with the same order), the rest are
// "also". An opaque agent id never becomes a visible name: the display name is
// the spawn's task, then its label, then the tag itself.
import { clipMiddle, type Scene } from "../labScene";

export type StationUser = { tag: string; name: string };

const NAME_MAX = 24;

export function stationUsers(scene: Scene, station: "disk" | "cmd" | "mcp"): StationUser[] {
  const on = (l: { focus: string; activeMcp: string | null }): boolean =>
    station === "mcp" ? l.activeMcp !== null : l.focus === station;
  const users: StationUser[] = [];
  if (on(scene)) users.push({ tag: "main", name: "main" });
  scene.subagents.forEach((c, i) => {
    if (!on(c)) return;
    const tag = `w${i + 1}`;
    const title = c.task.trim() !== "" ? c.task : (c.label ?? tag);
    users.push({ tag, name: clipMiddle(title, NAME_MAX) });
  });
  return users;
}

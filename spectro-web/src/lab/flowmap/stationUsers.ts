// Who is using an OS station right now. Owner call, 2026-08-26: an active
// station always says WHICH agent is on it — "main", or the worker's name.
//
// The order is the fold's own resolution order (main first, then children in
// spawn order) — the FIRST entry is the occupant whose content the station
// shows (sceneToFlow resolves the occupant with the same order), the rest are
// "also". An opaque agent id never becomes a visible name: the display name is
// the spawn's task, then its label, then the tag itself.
//
// CARD 298. The tag used to be `w${i + 1}` off the live scene array — a
// POSITION at the moment of the draw, not an identity. Handed a directory it
// reads the handle instead, folded from the event prefix and stable across the
// whole run. The local derivation stays as the fallback for a scene with no
// events behind it (the edu sim drives the scene directly), and produces the
// same line for an ordinary session; the one place the two disagree is a
// standalone subagent transcript, which roots at its own id — the index
// numbered that root as a worker, the directory knows it is the root.
import type { AgentDirectory } from "../agentDirectory";
import { clipMiddle, type Scene } from "../labScene";

export type StationUser = { tag: string; name: string };

const NAME_MAX = 24;

export function stationUsers(
  scene: Scene,
  station: "disk" | "cmd" | "mcp",
  dir?: AgentDirectory,
): StationUser[] {
  const on = (l: { focus: string; activeMcp: string | null }): boolean =>
    station === "mcp" ? l.activeMcp !== null : l.focus === station;
  const users: StationUser[] = [];
  if (on(scene)) users.push({ tag: "main", name: "main" });
  scene.subagents.forEach((c, i) => {
    if (!on(c)) return;
    const handle = dir?.get(c.id);
    if (handle !== undefined) {
      users.push({ tag: handle.tag, name: handle.name });
      return;
    }
    const tag = `w${i + 1}`;
    const title = c.task.trim() !== "" ? c.task : (c.label ?? tag);
    users.push({ tag, name: clipMiddle(title, NAME_MAX) });
  });
  return users;
}

// Who is using an OS station right now. Owner call, 2026-08-26: an active
// station always says WHICH agent is on it — "main", or the worker's name.
//
// Card 295 made this the SINGLE derivation. Occupancy used to be worked out
// twice: once here for the label chip, and once again in sceneToFlow (a
// `loops.find` per station) for the node's active state — two answers to the
// same question, free to drift, and neither of them could say WHICH rail is
// hot because the label carried no id. `stationOccupants` answers it once,
// carrying the agent's id and its own loop; `stationUsers` is that list
// filtered to one station.
//
// The order is the fold's own resolution order (main first, then children in
// spawn order) — the FIRST entry is the occupant whose content the station
// shows, the rest are "also". An opaque agent id never becomes a visible name:
// the display name is the spawn's task, then its label, then the tag itself.
//
// CARD 298. The tag used to be `w${i + 1}` off the live scene array — a
// POSITION at the moment of the draw, not an identity. Handed a directory it
// reads the handle instead, folded from the event prefix and stable across the
// whole run. The local derivation stays as the fallback for a scene with no
// events behind it (the edu sim drives the scene directly), and produces the
// same line for an ordinary session; the one place the two disagree is a
// standalone subagent transcript, which roots at its own id — the index
// numbered that root as a worker, the directory knows it is the root.
//
// MERGE 295+298. The directory is read where the ROSTER is built, not where a
// single station is filtered, so both readers of the one derivation — the "who
// is on it" chip and the node's `byTag` — get the same stable handle. Threading
// it into `stationUsers` alone would have left `byTag` on the positional tag.
import type { AgentDirectory } from "../agentDirectory";
import { clipMiddle, type Loop, type Scene } from "../labScene";

/** The three shared stations an agent can occupy. */
export type Station = "disk" | "cmd" | "mcp";

export type StationUser = { tag: string; name: string; agentId: string };

/** One (agent, station) pair, with the loop whose content that station shows. */
export type StationOccupant = StationUser & { station: Station; loop: Loop };

const NAME_MAX = 24;
const STATIONS: Station[] = ["disk", "cmd", "mcp"];

/** MCP occupancy is the HELD call, not the focus: an agent stopped at the
 *  permission gate still holds its MCP call, and the whole chain stays lit. */
function occupies(loop: Loop, station: Station): boolean {
  return station === "mcp" ? loop.activeMcp !== null : loop.focus === station;
}

export function stationOccupants(scene: Scene, dir?: AgentDirectory): StationOccupant[] {
  const roster: StationUser[] = [{ tag: "main", name: "main", agentId: "main" }];
  scene.subagents.forEach((c, i) => {
    const handle = dir?.get(c.id);
    if (handle !== undefined) {
      roster.push({ tag: handle.tag, name: handle.name, agentId: c.id });
      return;
    }
    const tag = `w${i + 1}`;
    const title = c.task.trim() !== "" ? c.task : (c.label ?? tag);
    roster.push({ tag, name: clipMiddle(title, NAME_MAX), agentId: c.id });
  });
  const loops: Loop[] = [scene, ...scene.subagents];
  const out: StationOccupant[] = [];
  roster.forEach((user, i) => {
    const loop = loops[i];
    for (const station of STATIONS) {
      if (occupies(loop, station)) out.push({ ...user, station, loop });
    }
  });
  return out;
}

export function stationUsers(scene: Scene, station: Station, dir?: AgentDirectory): StationUser[] {
  return stationOccupants(scene, dir)
    .filter((o) => o.station === station)
    .map(({ tag, name, agentId }) => ({ tag, name, agentId }));
}

// Card 430, criterion 9: the views of the surfaces light closes load from
// chunks of their own. Each one has exactly one import() here, App draws the
// lazy component under the name the module exports, and the entry chunk
// imports none of them statically (surfaceChunks.guard.test.ts builds the app
// and reads the manifest to hold that). The list of modules per surface is the
// surface table's (state/surfaces.ts).
//
// Light never draws these views, so it never requests their chunks. Learn
// fetches them once the browser is idle after the first render, so the first
// press on a tab does not wait for a download.
//
// A chunk that does not arrive rejects with a ChunkLoadError, and App draws
// each lazy view inside a ChunkBoundary (components/ChunkBoundary.tsx), which
// shows a notice with a reload in that view's place.

import { lazy } from "react";
import { scheduleWarm, type WarmHost } from "../components/traceWarmup";
import { isOpen, type SurfaceId } from "./surfaces";
import type { ViewMode } from "./viewMode";

/** The import() of a lazy view's chunk rejected: the file did not arrive. */
export class ChunkLoadError extends Error {
  /** The module whose chunk failed, relative to src/ and without extension. */
  readonly module: string;

  constructor(module: string, cause: unknown) {
    super(`the chunk of ${module} did not load`, { cause });
    this.name = "ChunkLoadError";
    this.module = module;
  }
}

/**
 * A loader whose rejection is a ChunkLoadError, so a boundary can tell a
 * missing chunk from an error the view itself threw.
 *
 * @param module the module the loader imports, relative to src/
 * @param load   the import()
 * @return the same loader, with its failure tagged
 */
export function chunk<T>(module: string, load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((cause: unknown) => {
      throw new ChunkLoadError(module, cause);
    });
}

const loadSpectrumView = chunk("spectrum/SpectrumView", () => import("../spectrum/SpectrumView"));
const loadTraceView = chunk("components/TraceView", () => import("../components/TraceView"));
const loadGraphView = chunk("graph/GraphView", () => import("../graph/GraphView"));
const loadTextView = chunk("components/TextView", () => import("../components/TextView"));
const loadLabView = chunk("lab/LabView", () => import("../lab/LabView"));
const loadFleetLobby = chunk("spectrum/FleetLobby", () => import("../spectrum/FleetLobby"));
const loadFleetBar = chunk("spectrum/FleetBar", () => import("../spectrum/FleetBar"));
const loadFleetBus = chunk("spectrum/FleetBus", () => import("../spectrum/FleetBus"));
const loadAgentFeed = chunk("spectrum/AgentFeed", () => import("../spectrum/AgentFeed"));
const loadFleetHome = chunk("spectrum/FleetHome", () => import("../spectrum/FleetHome"));
const loadFleetSpawn = chunk("spectrum/FleetSpawn", () => import("../spectrum/FleetSpawn"));
const loadFleetLab = chunk("lab/FleetLab", () => import("../lab/FleetLab"));
const loadStateGraphPane = chunk("stategraph/StateGraphPane", () => import("../stategraph/StateGraphPane"));
const loadPlaybookPane = chunk("playbook/PlaybookPane", () => import("../playbook/PlaybookPane"));

export const SpectrumView = lazy(() => loadSpectrumView().then((m) => ({ default: m.SpectrumView })));
export const TraceView = lazy(() => loadTraceView().then((m) => ({ default: m.TraceView })));
export const GraphView = lazy(() => loadGraphView().then((m) => ({ default: m.GraphView })));
export const TextView = lazy(() => loadTextView().then((m) => ({ default: m.TextView })));
export const LabView = lazy(() => loadLabView().then((m) => ({ default: m.LabView })));
export const FleetLobby = lazy(() => loadFleetLobby().then((m) => ({ default: m.FleetLobby })));
export const FleetBar = lazy(() => loadFleetBar().then((m) => ({ default: m.FleetBar })));
export const FleetBus = lazy(() => loadFleetBus().then((m) => ({ default: m.FleetBus })));
export const AgentFeed = lazy(() => loadAgentFeed().then((m) => ({ default: m.AgentFeed })));
export const FleetHome = lazy(() => loadFleetHome().then((m) => ({ default: m.FleetHome })));
export const FleetSpawnForm = lazy(() => loadFleetSpawn().then((m) => ({ default: m.FleetSpawnForm })));
export const FleetLab = lazy(() => loadFleetLab().then((m) => ({ default: m.FleetLab })));
export const StateGraphPane = lazy(() => loadStateGraphPane().then((m) => ({ default: m.StateGraphPane })));
export const PlaybookPane = lazy(() => loadPlaybookPane().then((m) => ({ default: m.PlaybookPane })));

/** The loaders of each surface's chunks, in the order of the table's list. */
export const SURFACE_LOADERS: Partial<Record<SurfaceId, ReadonlyArray<() => Promise<unknown>>>> = {
  spectrum: [loadSpectrumView],
  trace: [loadTraceView],
  graph: [loadGraphView],
  text: [loadTextView],
  lab: [loadLabView],
  fleets: [
    loadFleetLobby,
    loadFleetBar,
    loadFleetBus,
    loadAgentFeed,
    loadFleetHome,
    loadFleetSpawn,
    loadFleetLab,
  ],
  stategraph: [loadStateGraphPane],
  playbook: [loadPlaybookPane],
};

/**
 * Fetch the chunks of every surface the mode opens, once the browser is idle.
 * Light opens none of them and fetches nothing; the playbook's chunk is
 * fetched in developer and in no other mode (card 481). A chunk that fails to arrive
 * is left for the press that needs it.
 *
 * @param mode    the window's mode
 * @param host    the scheduling calls (the window)
 * @param loaders the loaders per surface
 * @return a cancel for the scheduled fetch
 */
export function prefetchSurfaces(
  mode: ViewMode,
  host: WarmHost,
  loaders: Partial<Record<SurfaceId, ReadonlyArray<() => Promise<unknown>>>> = SURFACE_LOADERS,
): () => void {
  const wanted = (Object.keys(loaders) as SurfaceId[])
    .filter((surface) => isOpen(surface, mode))
    .flatMap((surface) => loaders[surface] ?? []);
  if (wanted.length === 0) return () => {};
  return scheduleWarm(() => {
    for (const load of wanted) void load().catch(() => {});
  }, host);
}

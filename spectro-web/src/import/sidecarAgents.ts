// Card 177: the agents beside an imported session.
//
// A Claude Code session transcript holds only its own start. Measured over the
// 25 largest in this store: 71,329 records, and ZERO carrying `isSidechain`.
// Every word the agents said sits in sibling files the importer never opened —
// 718 direct `Task`/`Agent` spawns, and 4,069 under
// `<session>/subagents/workflows/<runId>/`, which is 85% of them.
//
// So the work panel was right to refuse. Its three labels ("reports 3 agents ·
// none of them in this stream") are the honest reading of a file that names
// work it does not record. This module hands it the evidence instead, and the
// refusal stays exactly as it is wherever the evidence is absent.
//
// Card 313 narrows where this listing speaks. A run whose agents an import has
// read INTO the stream is not a row of files any more, whatever this listing
// found on the disk; the panel asks the agents roster first and only reaches
// for these paths when the roster knows nothing (components/workLevels.ts
// besideReading).
//
// A LISTING, never a join at import time. Opening a session costs one directory
// walk; the bodies arrive one at a time, when a reader opens a row. Reading
// 4,045 files to open one session is the defect card 151 recorded for the
// session list, and repeating it here would trade one silence for a freeze.

/** One agent transcript beside a session, as the server names it. */
export interface SidecarAgent {
  agentId: string;
  /** Store-relative — what the content endpoint takes back. */
  path: string;
  /** The workflow run it belonged to, or null for a direct spawn. */
  runId: string | null;
  bytes: number;
  modifiedAt: number;
}

/** What the panel can ask about one imported session. */
export interface SidecarIndex {
  /** Every agent beside the session, direct spawns first. */
  all: readonly SidecarAgent[];
  /** The agents of one workflow run, in filename order; empty when unknown. */
  forRun: (runId: string) => readonly SidecarAgent[];
  /** The agent a spawn row names, or undefined — the id in the filename IS the
   *  id the parent's row carries, so this lookup is read and never guessed. */
  byAgentId: (agentId: string) => SidecarAgent | undefined;
}

/** The empty index: a session with nothing beside it reads exactly like one
 *  whose sidecars were never asked for, because for the panel it is the same
 *  fact — there is nothing to show. */
export const NO_SIDECARS: SidecarIndex = {
  all: [],
  forRun: () => [],
  byAgentId: () => undefined,
};

function indexOf(agents: SidecarAgent[]): SidecarIndex {
  const byRun = new Map<string, SidecarAgent[]>();
  const byId = new Map<string, SidecarAgent>();
  for (const a of agents) {
    if (a.runId !== null) {
      const list = byRun.get(a.runId);
      if (list === undefined) byRun.set(a.runId, [a]);
      else list.push(a);
    }
    // First wins: two files cannot honestly claim one agent id, and a later
    // one overwriting the first would make the panel's row depend on walk order.
    if (!byId.has(a.agentId)) byId.set(a.agentId, a);
  }
  return {
    all: agents,
    forRun: (runId) => byRun.get(runId) ?? [],
    byAgentId: (agentId) => byId.get(agentId),
  };
}

/**
 * Ask the server which agents sit beside one session.
 *
 * @param path the session transcript, store-relative — the same string the
 *             import dialog listed it under
 * @return the index; the empty one for every failure, because a panel that
 *         cannot reach the store must say what it always said rather than
 *         claim a session has no agents
 */
export async function loadSidecarAgents(path: string): Promise<SidecarIndex> {
  try {
    const res = await fetch(`/api/claude/transcripts/sidecars?path=${encodeURIComponent(path)}`);
    if (!res.ok) return NO_SIDECARS;
    const body: unknown = await res.json();
    const agents = (body as { agents?: unknown })?.agents;
    if (!Array.isArray(agents)) return NO_SIDECARS;
    const rows: SidecarAgent[] = [];
    for (const raw of agents) {
      const a = raw as Partial<SidecarAgent>;
      if (typeof a?.agentId !== "string" || typeof a?.path !== "string") continue;
      rows.push({
        agentId: a.agentId,
        path: a.path,
        runId: typeof a.runId === "string" ? a.runId : null,
        bytes: typeof a.bytes === "number" ? a.bytes : 0,
        modifiedAt: typeof a.modifiedAt === "number" ? a.modifiedAt : 0,
      });
    }
    return indexOf(rows);
  } catch {
    return NO_SIDECARS;
  }
}

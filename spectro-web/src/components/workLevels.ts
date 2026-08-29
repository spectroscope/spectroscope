// Pure helpers for the work panel (branch chat-v2). The component renders
// these; the test covers them. No React and no DOM, the house convention.
//
// The panel has three levels, and each one is a fold of the level below:
//
//   group  — a wave of work of ONE kind under ONE parent. The closest thing our
//            stream has to the reference tool's "workflow" card, and the only
//            honest one: the reference DECLARES its phases in the launching
//            script, we observe ours.
//   item   — one lane, one triggered run, or one launched task.
//   child  — an item's own children, when it spawned any.
//
// Honesty rules that live here rather than in the markup, so they can be tested:
//   1. A figure with no frame behind it is not printed.
//   2. A count a task REPORTED about work outside this stream is quoted as such
//      and never drawn as rows.
//   3. A single-member group still says "1", because a wave of one is a real
//      reading and a hidden one is a lie of omission.

import type { WorkItem, WorkKind, WorkState } from "../state/work";
import { groupWaves } from "../state/work";
import { formatDuration } from "../format";
import type { AgentInfo } from "../state/reducer";
import type { SidecarAgent, SidecarIndex } from "../import/sidecarAgents";

export interface WorkGroup {
  id: string;
  kind: WorkKind;
  parentId: string | null;
  /** The shared label when every member carries the same one, else null. */
  label: string | null;
  items: WorkItem[];
  firstTs: number | null;
  lastTs: number | null;
  done: number;
  total: number;
  inTokens: number;
  outTokens: number;
  toolCalls: number;
  gatesAsked: number;
  gatesDenied: number;
  gatePending: boolean;
  state: WorkState;
}

/** Worst-first: one working lane keeps the group working, one failure shows. */
export function groupState(items: readonly WorkItem[]): WorkState {
  if (items.some((i) => i.state === "failed")) return "failed";
  if (items.some((i) => i.state === "working")) return "working";
  if (items.some((i) => i.state === "submitted")) return "submitted";
  return items.length === 0 ? "submitted" : "completed";
}

/**
 * Bucket top-level items into groups: same parent, same kind, overlapping spans.
 *
 * Kind comes before time on purpose. A subagent fan-out and a background launch
 * that happen to overlap are not one wave of work, they are two things going on
 * at once, and a card that averages them describes neither.
 *
 * @param items top-level work items
 * @return groups in start order
 */
export function workGroups(items: readonly WorkItem[]): WorkGroup[] {
  const buckets = new Map<string, WorkItem[]>();
  for (const item of items) {
    // NUL separates the two halves so the key cannot blur, whatever a parent id off the wire
    // carries. It is defensive rather than load-bearing today: the three kinds differ at their
    // first character and the wave id repeats the parent id, so " " or "-" would bucket exactly
    // the same way, and no test pins the choice. Written as the escape and never as a raw byte,
    // because a raw 0x00 makes git call the whole file binary and every diff of it then prints
    // "Binary files differ" with no hunks to review.
    const key = `${item.kind}\x00${item.parentId ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const out: WorkGroup[] = [];
  for (const [key, bucket] of buckets) {
    for (const wave of groupWaves(bucket)) {
      const first = wave.items[0];
      const labels = new Set(wave.items.map((i) => i.name));
      out.push({
        id: `${key}\x00${wave.id}`,
        kind: first.kind,
        parentId: first.parentId,
        label: labels.size === 1 ? first.name : null,
        items: wave.items,
        firstTs: wave.firstTs,
        lastTs: wave.lastTs,
        done: wave.items.filter((i) => i.state === "completed" || i.state === "failed").length,
        total: wave.items.length,
        inTokens: wave.items.reduce((n, i) => n + i.inTokens, 0),
        outTokens: wave.items.reduce((n, i) => n + i.outTokens, 0),
        toolCalls: wave.items.reduce((n, i) => n + i.toolCalls, 0),
        gatesAsked: wave.items.reduce((n, i) => n + i.gatesAsked, 0),
        gatesDenied: wave.items.reduce((n, i) => n + i.gatesDenied, 0),
        gatePending: wave.items.some((i) => i.gatePending),
        state: groupState(wave.items),
      });
    }
  }
  return out.sort((a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0));
}

/**
 * The elapsed label for a span, or null when the stream never stamped one.
 *
 * Null is load-bearing: a work item whose events carry no timestamp has an
 * unknown duration, and "0s" would be a measurement we did not take.
 */
export function elapsedLabel(firstTs: number | null, lastTs: number | null): string | null {
  if (firstTs === null || lastTs === null) return null;
  return formatDuration(Math.max(0, lastTs - firstTs));
}

/** Compact token count, the AgentsTab spelling: 1234 -> "1.2k". */
export function tokenLabel(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

/** What a launch row may say about the agents of its run. See {@link besideReading}. */
export type BesideReading =
  | { kind: "inStream"; agents: readonly string[]; claimed: number | null }
  | { kind: "files"; files: readonly SidecarAgent[]; claimed: number | null }
  | { kind: "claim"; claimed: number; toolUses: number | null };

/**
 * Which of the three a row gets — ONE decision.
 *
 * Card 313. The panel used to hold two: an opaque line ("none of them in this
 * stream") and a file list with byte sizes, each with its own condition. Card
 * 297 then loaded a workflow run's agents INTO the stream, and the two folds
 * disagreed with the agents panel about the same agents on the same screen.
 *
 * Presence is therefore not derived a second time here. It is read off the
 * AGENTS PANEL'S OWN ROSTER — `UiState.agents`, the array AgentsTab renders,
 * typed {@link AgentInfo} so the compiler holds a caller to that source — by
 * the parent link the roster itself carries. What the agents panel lists as an
 * agent of this node is what this row calls an agent.
 *
 * Three readings, in the order that outranks:
 *   inStream — the roster lists agents under this item. They are agents; the
 *              rows are already drawn under this one, and no file is named.
 *   files    — none are in the stream, and their transcripts sit beside the
 *              session. The old list, byte sizes and all, unchanged.
 *   claim    — neither. All this row has is the number the receipt reported,
 *              and it says so in the words it always used.
 *
 * @param item     the row
 * @param roster   the agents panel's own roster
 * @param sidecars what the store listed beside the session (card 177)
 * @return the reading, or null for a row that never launched anything
 */
export function besideReading(
  item: WorkItem,
  roster: readonly AgentInfo[],
  sidecars: SidecarIndex,
): BesideReading | null {
  // A row that carries neither a receipt nor a run id never launched anything
  // this question is about: an ordinary fan-out lane has children and must not
  // grow a sentence about "this run" because of them.
  if (item.opaque === null && item.runId === null) return null;
  const claimed = item.opaque?.agents ?? null;
  const inStream = roster.filter((a) => a.parentId === item.id).map((a) => a.id);
  if (inStream.length > 0) return { kind: "inStream", agents: inStream, claimed };
  const files = item.runId === null ? [] : sidecars.forRun(item.runId);
  if (files.length > 0) return { kind: "files", files, claimed };
  if (claimed === null) return null;
  return { kind: "claim", claimed, toolUses: item.opaque?.toolUses ?? null };
}

/**
 * The figures this item cannot show, as reason codes the panel translates.
 *
 * A prototype that quietly omits what it lacks teaches the reader to trust a
 * card that is lying by silence. These codes become a visible line instead.
 *
 * `agentsInStream` carries the same condition as {@link besideReading}, and it
 * is required rather than defaulted: every code below except the span is a
 * claim that this row's work happened SOMEWHERE ELSE, and a caller that has
 * not answered the question has not earned any of them. Card 313 — the codes
 * were written when a launch's agents could not be loaded, and card 297 made
 * that false for a workflow run whose agents are right here.
 *
 * @param item          the row
 * @param agentsInStream whether the agents panel lists this row's agents
 * @return the reason codes, in reading order
 */
export function absences(item: WorkItem, agentsInStream: boolean): string[] {
  const out: string[] = [];
  if (item.firstTs === null || item.lastTs === null) out.push("span");
  // The span is measured either way; everything below is about work that is
  // not here, and with the agents loaded there is no such work to report.
  if (agentsInStream) return out;
  if (item.kind === "launched") {
    // The measured shape of the reference's record: eight numbers at
    // settlement, and the per-agent detail in sibling files this stream never
    // saw. See konzept/CHAT-V2.md section 4.3.
    out.push("agentRows");
    if (item.inTokens === 0 && item.outTokens === 0) out.push("tokens");
    if (item.toolCalls === 0) out.push("calls");
    return out;
  }
  // A lane the file NAMES and never records. Measured on a real import
  // (c8fefa6e…, five "Explore" children): a Claude Code transcript whose
  // subagent records are not sidechains announces its children and carries not
  // one frame of their work — spawn and result seventeen milliseconds apart,
  // and nothing in between. That is card 109's "imported sessions are second
  // class", and a card reading "0.0 s" with no numbers has to say why rather
  // than look broken.
  //
  // The test is what was RECORDED, not how short the span is: a lane can be
  // fast and still have a usage frame, and a lane with neither tokens nor calls
  // has left nothing behind whatever its bookends say.
  if (item.evidence.tokens === null && item.toolCalls === 0) out.push("noWork");
  return out;
}

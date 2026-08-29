// Card 306: the interior of ONE workflow box, as pure geometry.
//
// THE SHAPE, written down before anything was built.
//
//   ┌───────────────────────────────────────────────┐
//   │ header: name · phases k/n · N agents · state  │  ← BOX_HEADER_H
//   ├───────────────────────────────────────────────┤
//   │ ▸ survey                                      │  ← BOX_BAND_LABEL_H
//   │   [ a1 ]                                      │
//   ├───────────────────────────────────────────────┤
//   │ ▸ fan out                                     │
//   │   [ b1 ] [ b2 ] [ b3 ] [ b4 ] [ b5 ]          │  ← the flow, lined up
//   ├───────────────────────────────────────────────┤
//   │ ▸ fold                                        │
//   │   [ c1 ]                                      │
//   └───────────────────────────────────────────────┘
//
// VERTICAL, so the box reads as one block in the lab: the phases run DOWN in
// their declared order, and the agents of one phase stand SIDE BY SIDE across
// it. The band is what separates the phases — it is the flow with its stages
// visible, not a bag of agents.
//
// EVERY NUMBER HERE IS RELATIVE TO THE BOX'S OWN ORIGIN. That is not a detail:
// the members are React Flow CHILD nodes (parentId + extent "parent"), and a
// child's position is measured from its parent's top-left. World coordinates
// are somebody else's job — `worldBoxes` in worldBox.ts — and the two must
// never be confused, because a wrong one is still a number and fails silently.
//
// Pure on purpose: no DOM, no React, no i18n. The one word this file cannot
// derive — what to call the band for agents the run could not place — is
// handed in already translated, the same rule `WorkflowNode` follows for its
// state labels.

import { SUB_CARD_H, SUB_CARD_W } from "./cardGeometry";
import type { PhaseMember, RunPhases } from "../workflowGraph";

/** The band the box's own heading occupies: name, progress, count, state. */
export const BOX_HEADER_H = 46;
/** Air inside the box's frame, on every side. */
export const BOX_PAD = 14;
/** One phase's own title strip, above the agents that ran in it. */
export const BOX_BAND_LABEL_H = 24;
/** Air between a band's title strip and the row of agents under it. */
export const BOX_BAND_INSET = 6;
/** Air below the agent row, inside the band. */
export const BOX_BAND_FOOT = 10;
/** The separation between two phases — what makes the stages visible. */
export const BOX_BAND_GAP = 12;
/** Rail room between two agents standing in the same phase. */
export const BOX_MEMBER_GAP = 16;
/** How tall a band with no agent in it is drawn. A phase the run never entered
 *  is a fact worth showing, so it keeps a body rather than collapsing to its
 *  own title. */
export const BOX_EMPTY_BODY_H = 26;

/** The compact member card — `.pf-sub` in flowmap.css, and the same 216 the
 *  map's own compact column pitch is built on. */
export const BOX_MEMBER_W_COMPACT = 216;

// ---------------------------------------------------------------------------
// WHAT A COMPACT MEMBER CARD COSTS — measured, then bounded.
//
// This was 132: the map's own compact seat (`SUB_H` in sceneToFlow), reused
// here because a member IS that card. In the map a 44px rail gap swallows
// whatever the card runs over by; a band has 10px of foot and 12px of gap, and
// `extent: "parent"` does not let a child stick out of its box, it CLAMPS —
// so a card that outgrows its band does not spill over the frame, it lands on
// the row above.
//
// Measured 2026-08-29 in Chrome at devicePixelRatio 1, off the shipped
// "declared workflow" scenario at frame 141/188 with the lab in compact, read
// through `offsetHeight` (React Flow's zoom is a viewport transform, so it is
// not in these numbers). The thirteen cards a box actually held:
//
//   112  two cards   (one-line head, no disclosure)
//   133  eight cards (one-line head, disclosure shut)
//   149  three cards (head wrapped to two lines, disclosure shut)
//
// Eleven of thirteen stood taller than the 132 reserved for them. And the
// parts they are made of, same pass:
//
//   frame     26  = .pf-card border 1 twice + .pf-sub padding 12 twice
//   head      21 at one line, 37 at two
//   task      margin 8, then 16 at one line (its own cap allows 46)
//   status    margin 8, then 17
//   shut disc margin 10, then 27 (border 1 + padding 9 + button 17)
//
// So the reserve below is the SUM of those parts with every growing one capped
// in flowmap.css — the same doctrine `cardGeometry.ts` applies to the expanded
// worker card. It bounds the card as a box draws it: shut. A reader who opens
// a member's disclosure by hand grows it past this, and React Flow clamps that
// card back inside the box; that is the same trade the map's own compact seat
// makes, and it is not what this constant claims.
// ---------------------------------------------------------------------------

/** `.pf-card` border twice plus `.pf-sub` padding twice. */
export const BOX_MEMBER_FRAME_H = 26;
/** `.pf-sub__task` and `.pf-sub__status` each open with this much air. */
export const BOX_MEMBER_ROW_GAP = 8;
/** The head: two lines of "label · id" beside the state badge, then it clips. */
export const BOX_MEMBER_CAP_HEAD_PX = 37;
/** The order the spawner phrased: two lines inside a box, then it clips. */
export const BOX_MEMBER_CAP_TASK_PX = 32;
/** The activity line: one line, then it clips. */
export const BOX_MEMBER_CAP_STATUS_PX = 17;
/** The disclosure as a box draws it — shut: its own margin plus its strip. */
export const BOX_MEMBER_DISC_SHUT_H = 37;

/** The tallest card measured in a box on the shipped scenario. The reserve has
 *  to hold it; `workflowBox.test.ts` is where that is said. */
export const BOX_MEMBER_MEASURED_MAX = 149;
/** And the shortest — the yardstick for the other arm, a seat that reserves
 *  more than twice the card it holds (the under-fill rule of card 296). */
export const BOX_MEMBER_MEASURED_MIN = 112;

/** What one band reserves for one agent: every part of the card above, each of
 *  the growing ones capped in flowmap.css so this is a bound and not an
 *  observation. 165 against a tallest measured 149. */
export const BOX_MEMBER_H_COMPACT =
  BOX_MEMBER_FRAME_H +
  BOX_MEMBER_CAP_HEAD_PX +
  BOX_MEMBER_ROW_GAP +
  BOX_MEMBER_CAP_TASK_PX +
  BOX_MEMBER_ROW_GAP +
  BOX_MEMBER_CAP_STATUS_PX +
  BOX_MEMBER_DISC_SHUT_H;

/**
 * What one agent card occupies inside a box.
 *
 * The two forms are the two that ALREADY EXIST (card 287): the compact
 * `.pf-sub` and the 680px instrument painted at zoom .6, whose world size is
 * `cardGeometry`'s measured pair. Nothing new is invented here — the switch
 * picks between the cards the map already draws.
 */
export function boxMemberSize(expanded: boolean): { w: number; h: number } {
  return expanded ? { w: SUB_CARD_W, h: SUB_CARD_H } : { w: BOX_MEMBER_W_COMPACT, h: BOX_MEMBER_H_COMPACT };
}

/** One agent, seated relative to the BOX's origin. */
export interface BoxMember {
  agentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One phase's band, seated relative to the BOX's origin. */
export interface BoxBand {
  title: string;
  detail: string | null;
  /** True for the band holding agents the run's own file could not place. */
  unplaced: boolean;
  y: number;
  h: number;
  members: BoxMember[];
}

/** One box's whole interior. */
export interface BoxLayout {
  w: number;
  h: number;
  headerH: number;
  bands: BoxBand[];
  /** Exactly the agent ids this box seated, in band order. The seating rule
   *  takes these OUT of the concurrency pool — one list, so the box and the
   *  pool can never disagree about who is where. */
  placed: string[];
}

export interface BoxOptions {
  /** The per-box switch: minimal members, or the full instrument. */
  expanded: boolean;
  /** The agent ids the scene actually drew, or null for "place them all".
   *  A declaration names agents a scrubbed prefix has not reached yet, and a
   *  card for an agent the scene does not hold would be an invention. */
  present: ReadonlySet<string> | null;
  /** Already translated — this file stays language-free. */
  unplacedTitle: string;
}

/** A band's height for a given member count. */
function bandHeight(members: number, memberH: number): number {
  const body = members === 0 ? BOX_EMPTY_BODY_H : memberH;
  return BOX_BAND_LABEL_H + BOX_BAND_INSET + body + BOX_BAND_FOOT;
}

/**
 * One run's declared phases → the box that holds them.
 *
 * @param run what the run's own state file declared and recorded
 * @param opts the switch, who is on screen, and the one word this file cannot
 *             derive
 */
export function workflowBoxLayout(run: RunPhases, opts: BoxOptions): BoxLayout {
  const size = boxMemberSize(opts.expanded);
  const keep = (m: PhaseMember): boolean => opts.present === null || opts.present.has(m.agentId);
  const declared = run.phases.map((p) => ({
    title: p.title,
    detail: p.detail,
    unplaced: false,
    members: p.members.filter(keep),
  }));
  const stray = run.unplaced.filter(keep);
  const rows =
    stray.length > 0
      ? [...declared, { title: opts.unplacedTitle, detail: null, unplaced: true, members: stray }]
      : declared;

  const bands: BoxBand[] = [];
  const placed: string[] = [];
  let y = BOX_HEADER_H + BOX_PAD;
  let widest = 0;
  for (const row of rows) {
    const h = bandHeight(row.members.length, size.h);
    const memberY = y + BOX_BAND_LABEL_H + BOX_BAND_INSET;
    const members: BoxMember[] = row.members.map((m, i) => ({
      agentId: m.agentId,
      x: BOX_PAD + i * (size.w + BOX_MEMBER_GAP),
      y: memberY,
      w: size.w,
      h: size.h,
    }));
    for (const m of members) placed.push(m.agentId);
    const rowW = members.length === 0 ? 0 : members.length * size.w + (members.length - 1) * BOX_MEMBER_GAP;
    widest = Math.max(widest, rowW);
    bands.push({ title: row.title, detail: row.detail, unplaced: row.unplaced, y, h, members });
    y += h + BOX_BAND_GAP;
  }

  // The last band leaves no gap under it — only padding.
  const bottom = bands.length === 0 ? BOX_HEADER_H : y - BOX_BAND_GAP;
  return {
    // Never narrower than one member: an all-empty run still has to read as a
    // box with a header in it, not as a rule.
    w: 2 * BOX_PAD + Math.max(widest, size.w),
    h: bottom + BOX_PAD,
    headerH: BOX_HEADER_H,
    bands,
    placed,
  };
}

/**
 * The per-box switch, as a pure fold.
 *
 * A Set of the boxes whose switch the reader has thrown, and one function that
 * flips one of them. It lives here rather than inside a component because the
 * seating reads the same set: the layout key that names the map's seating has
 * to include it, or the key would claim a seating the map is not in.
 *
 * @param thrown the boxes currently switched away from the global default
 * @param boxId the box whose switch was clicked
 */
export function toggleBox(thrown: ReadonlySet<string>, boxId: string): ReadonlySet<string> {
  const next = new Set(thrown);
  if (!next.delete(boxId)) next.add(boxId);
  return next;
}

/**
 * A stable string for a set of thrown switches.
 *
 * The map's layout key is a string, and a Set has no stable spelling — two
 * equal sets built in different orders would read as two different seatings
 * and re-lay the whole map out for nothing. Sorted, so the key says what it
 * means.
 */
export function boxSwitchKey(thrown: ReadonlySet<string>): string {
  return [...thrown].sort().join(",");
}

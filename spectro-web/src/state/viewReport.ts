// The two-way seam between a view and the address (card 181, second leg).
//
// The grammar in viewState.ts says what a reading LOOKS like. This says how it
// gets out of a view and back into one, and it is a module store for the reason
// the house always gives: a React context here would wrap App's whole render to
// share three fields, and card 179 measured that at 1,241 re-indented JSX lines.
// The pattern is stepper.ts / imageViewer.ts / sendQueue.ts.
//
// Traffic runs in both directions and they are deliberately NOT symmetric.
//
// Outbound, a view REPORTS: it says what it is showing whenever that changes,
// and App folds the report for the visible tab into the address. Reports are
// kept per tab, because the address describes the view you are looking at; a
// trace row hanging off a spectrum link is state nobody chose and nobody sees.
//
// Inbound, an address is OFFERED and TAKEN ONCE. A view that re-applied its
// incoming state on every render could never be scrolled or zoomed away from,
// so the offer is consumed the first time the view asks for it and is gone.

import type { ViewState } from "./viewState";
import type { ViewTab } from "./route";

/** The tabs that have a reading worth addressing. The others show one thing. */
export type ReportingTab = Extract<ViewTab, "trace" | "spectrum">;

const NOTHING: ViewState = {};

let reports: Partial<Record<ReportingTab, ViewState>> = {};
let incoming: Partial<Record<ReportingTab, ViewState>> = {};
/** Bumped by every offer, so a view can depend on "an address arrived" rather
 *  than on its own data changing. See {@link incomingGeneration}. */
let generation = 0;
const listeners = new Set<() => void>();

/** Field-wise equality. The store is read during render, so a report that says
 *  nothing new must not wake anybody: a spectrum reporting on every frame of a
 *  drag would otherwise re-render the whole app per frame. */
function same(a: ViewState | undefined, b: ViewState): boolean {
  if (a === undefined) return false;
  if (a.row !== b.row) return false;
  if ((a.win?.a ?? null) !== (b.win?.a ?? null) || (a.win?.b ?? null) !== (b.win?.b ?? null)) return false;
  const x = a.only;
  const y = b.only;
  if (x === undefined || y === undefined) return x === y;
  return x.length === y.length && x.every((c, i) => c === y[i]);
}

function nothingToSay(v: ViewState): boolean {
  return v.row === undefined && v.only === undefined && v.win === undefined;
}

/**
 * A view says what it is showing. Called on every change the address cares
 * about; a report identical to the last one is free.
 *
 * @param tab   the view reporting
 * @param state what it is showing
 */
export function reportView(tab: ReportingTab, state: ViewState): void {
  if (same(reports[tab], state)) return;
  reports = { ...reports, [tab]: state };
  listeners.forEach((wake) => wake());
}

/**
 * What the given tab is showing, for the address.
 *
 * @param tab the visible tab, or null for the chat default
 * @returns its report, or an empty reading for a tab that reports nothing
 */
export function reportedViewFor(tab: ViewTab | null): ViewState {
  if (tab === null) return NOTHING;
  return reports[tab as ReportingTab] ?? NOTHING;
}

/** Subscribe to reports. Returns the unsubscribe. */
export function subscribeReportedViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Everything is forgotten: the session under the views changed.
 *
 * Row 12 of one session addresses nothing in the next one, and a window fitted
 * to one run's clock means nothing against another's. Carrying either across
 * would put a reading in the address that the view on screen never had.
 */
export function clearReportedViews(): void {
  const had = Object.keys(reports).length > 0;
  reports = {};
  incoming = {};
  if (had) listeners.forEach((wake) => wake());
}

/** Test-only: put the counter back so a run starts where the last one did. */
export function __resetIncomingGeneration(): void {
  generation = 0;
}

/**
 * An address hands a view its reading, to be applied when that view next
 * mounts or notices.
 *
 * An offer that says nothing is dropped rather than stored: a link with no
 * query means "however you have it", not "reset this view to nothing".
 *
 * @param tab   the view the address named
 * @param state what it should show
 */
export function offerIncomingView(tab: ReportingTab, state: ViewState): void {
  if (nothingToSay(state)) return;
  incoming = { ...incoming, [tab]: state };
  generation += 1;
  listeners.forEach((wake) => wake());
}

/**
 * A counter that moves on every offer. A view depends on THIS, not on its own
 * data, to know an address has something for it.
 *
 * Found live, and it is the whole reason this exists: the trace took its
 * incoming reading in an effect keyed on the entries. Navigating within a
 * session does not change the entries, so back and forward between two
 * readings of one session moved the address and left the view where it was.
 * Two identical offers are two navigations and both must land, which is why
 * this counts rather than describing what arrived.
 *
 * @returns the current generation
 */
export function incomingGeneration(): number {
  return generation;
}

/**
 * A view takes the reading an address left for it, once.
 *
 * @param tab the view asking
 * @returns the reading, or undefined when there is none waiting
 */
export function takeIncomingView(tab: ReportingTab): ViewState | undefined {
  const waiting = incoming[tab];
  if (waiting === undefined) return undefined;
  const { [tab]: _taken, ...rest } = incoming;
  incoming = rest;
  return waiting;
}

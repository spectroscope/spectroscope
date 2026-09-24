// What a keystroke in the composer means, and how the walk through earlier
// prompts moves. Card 378.
//
// All of it is pure and all of it lives here rather than in Chat.tsx, for a
// reason that is not style: this suite has no DOM. vite.config.ts carries no
// `test` block, so vitest runs in the node environment, and jsdom, happy-dom
// and testing-library are all absent from package.json. A walk held in
// `useState` could not be reached by any test in this tree. A step function can.
//
// The house pattern being followed is keyToIntent in spectrum/gestures.ts: the
// pure function classifies the key and the CALL SITE keeps the gating
// condition, so the slash picker still gets first refusal on every key without
// this module knowing the picker exists.

/** The fields of a composer keydown this module reads. */
export interface ComposerChord {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** True while an IME is mid-composition; the candidate list owns the key. */
  isComposing?: boolean;
  /** The draft as the field holds it right now. */
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** What the composer should do with a key. */
export type ComposerAction = "send" | "recall-back" | "recall-forward" | "pass";

/**
 * Classifies a keydown in the message box.
 *
 * <p>The arrow rule is the terminal's, taken from zsh's `up-line-or-history`:
 * an arrow moves within the text while there is a line to move to, and only
 * reaches the history from the edge. It is measured over LOGICAL lines, which
 * is the limit of this rule and is recorded on the card: a soft-wrapped single
 * logical line spanning three visual rows recalls on the first press, because
 * telling visual rows apart means measuring the DOM.</p>
 *
 * <p>Enter keeps exactly the rule the composer already had, shift and nothing
 * else, so moving it in here changes no behaviour and pins it for the first
 * time.</p>
 *
 * @param e the keydown, with the field's value and selection
 * @return what the composer should do
 */
export function composerKeyAction(e: ComposerChord): ComposerAction {
  if (e.isComposing === true) return "pass";
  if (e.key === "Enter") return e.shiftKey ? "pass" : "send";
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return "pass";
  // A modified arrow belongs to the platform or to a selection, never here.
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return "pass";
  if (e.selectionStart !== e.selectionEnd) return "pass";
  if (e.key === "ArrowUp") {
    return e.value.slice(0, e.selectionStart).includes("\n") ? "pass" : "recall-back";
  }
  return e.value.slice(e.selectionEnd).includes("\n") ? "pass" : "recall-forward";
}

/** One prompt the walk can bring back. */
export interface RecallEntry {
  text: string;
  /**
   * The queue id, when this entry is a message still waiting for the run to
   * end. Recalling it takes it out of the queue, so the id is needed at the
   * moment of the recall and never again.
   */
  queueId?: number;
}

/**
 * The shape of a turn this module reads.
 *
 * <p>`text` is optional because the reducer's Turn is a union and its tool arm
 * carries a callId and no text at all. Requiring it here would not make that
 * arm go away, it would only move the error to the call site.</p>
 */
interface TurnLike {
  kind: string;
  text?: string;
}

/** The shape of a queued message this module reads. */
interface QueuedLike {
  id: number;
  text: string;
}

/**
 * The prompts the walk can reach, newest first.
 *
 * <p>The waiting queue comes first because those messages were typed most
 * recently, and the newest queued one is the nearest of them. Duplicates keep
 * their newest copy: a prompt sent twice is one entry, or the walk would ask
 * for two presses to get past the same text.</p>
 *
 * @param turns the session's turns, oldest first, as the reducer holds them
 * @param queued the messages waiting for the run to end, oldest first
 * @return the entries, newest first, blank texts dropped
 */
export function recallEntries(turns: readonly TurnLike[], queued: readonly QueuedLike[]): RecallEntry[] {
  const out: RecallEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: RecallEntry): void => {
    if (entry.text.trim() === "" || seen.has(entry.text)) return;
    seen.add(entry.text);
    out.push(entry);
  };
  for (let i = queued.length - 1; i >= 0; i--) {
    const m = queued[i];
    if (m !== undefined) push({ text: m.text, queueId: m.id });
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn !== undefined && turn.kind === "user" && turn.text !== undefined) {
      push({ text: turn.text });
    }
  }
  return out;
}

/**
 * Where the walk stands.
 *
 * <p>`entries` is a FROZEN copy taken on the first step back, not the live
 * list. The component recomputes the live list on every render and a recall of
 * a queued entry empties the queue, so reading the live list on the second
 * step would land the walk on a different prompt than the one the counter just
 * promised.</p>
 */
export interface WalkState {
  /** The entry being shown, 0 = newest. -1 means the operator's own draft. */
  index: number;
  /** The unsent draft, put aside on the first step back. */
  stash: string;
  /** The list this walk is walking, frozen when it started. */
  entries: readonly RecallEntry[];
  /** Edits made at an entry, by index: zsh keeps them until the line is sent. */
  edits: Readonly<Record<number, string>>;
}

/** A walk that has not started: the operator is in his own draft. */
export function atDraft(): WalkState {
  return { index: -1, stash: "", entries: [], edits: {} };
}

/** What one step produced. */
export interface WalkStep {
  state: WalkState;
  /** What the box should hold; the current text unchanged when nothing moved. */
  text: string;
  /** False at either end of the list; the caller then leaves the key alone. */
  moved: boolean;
  /** The queue id to remove, on the step that recalls a waiting message. */
  unqueue: number | null;
}

/**
 * One step of the walk.
 *
 * @param state where the walk stands
 * @param direction "back" is further into the past, "forward" is towards the draft
 * @param available the live entry list, consulted only when the walk starts
 * @param current what the box holds right now, stashed or kept as an edit
 * @return the next state, the text to show, and any queue removal it owes
 */
export function walkStep(
  state: WalkState,
  direction: "back" | "forward",
  available: readonly RecallEntry[],
  current: string,
): WalkStep {
  const stay: WalkStep = { state, text: current, moved: false, unqueue: null };
  const entries = state.index === -1 ? available : state.entries;
  const next = direction === "back" ? state.index + 1 : state.index - 1;
  if (next >= entries.length || next < -1) return stay;

  // What the box holds is kept before it is replaced: the unsent draft goes to
  // the stash on the first step back, anything else is an edit of its entry.
  const stash = state.index === -1 ? current : state.stash;
  const edits = state.index === -1 ? {} : { ...state.edits, [state.index]: current };

  if (next === -1) {
    return { state: { ...atDraft(), edits }, text: stash, moved: true, unqueue: null };
  }
  const entry = entries[next];
  if (entry === undefined) return stay;
  const unqueue = entry.queueId ?? null;
  // The id is spent: the entry has left the queue, and a later step that lands
  // here again must not ask for a removal that already happened.
  const kept = unqueue === null ? entries : entries.map((e, i) => (i === next ? { text: e.text } : e));
  return {
    state: { index: next, stash, entries: kept, edits },
    text: edits[next] ?? entry.text,
    moved: true,
    unqueue,
  };
}

/** What the counter row above the box reports. */
export type RecallReadout = { kind: "idle" } | { kind: "at"; position: number; total: number };

/**
 * The counter above the box, one based and newest first.
 *
 * <p>Modelled on `searchReadout` in SearchBox.tsx: pure, one based, and a
 * discriminated union so the row renders from this and from nothing else. At
 * the operator's own draft there is no position, and a row reading `0/2` would
 * invent one, so the readout is idle and the row is absent.</p>
 *
 * @param state where the walk stands
 * @return idle at the draft, otherwise the position and the total
 */
export function recallReadout(state: WalkState): RecallReadout {
  if (state.index < 0 || state.entries.length === 0) return { kind: "idle" };
  return { kind: "at", position: state.index + 1, total: state.entries.length };
}

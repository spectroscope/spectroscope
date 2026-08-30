// Card 309A, fix round: the CLICK is the card's own verb, so the click is
// pinned here.
//
// WHAT WAS HOLLOW. The panel's headline promise is "a click SEEKS the replay
// there, the same seek the tick already does". Nothing held it. Three mutations
// were applied separately against the whole suite and all three stayed green:
// `seek(moment.cursor)` swapped for `seek(0)`; the handler body replaced with
// `void moment;`, so the button did nothing at all; and `setMode("step")`
// dropped, so auto-play walks away from every landing. The fold-level equality
// — the cursor a row names is the boundary the tick seeks to — was pinned
// superbly in moments.test.ts. The WIRE from the button to the transport held
// nothing.
//
// WHY IT IS TESTED LIKE THIS. There is no DOM in this gate (no jsdom, no
// happy-dom — see scrubStaysDraggable.drift.test.ts for the same constraint),
// and `renderToStaticMarkup` throws every handler away: markup can show that a
// button EXISTS, never what it does. `MomentRow` carries no hooks, so it is
// called the way React calls it, the returned element tree is walked for the
// button, and that button's own `onClick` is invoked against a stepper whose
// two transport verbs are spies. That is the real handler, reached through the
// real element — not a copy of it written here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Partial on purpose: `momentsOf` folds through this same module
// (chapterMarks/stepBoundaries/stepOfEvent), so the cursors the assertions
// compare against must be the REAL ones. Only the two verbs that move the
// transport are spies.
const seek = vi.fn<(n: number) => void>();
const setMode = vi.fn<(mode: string) => void>();
vi.mock("../state/stepper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/stepper")>()),
  seek: (n: number) => seek(n),
  setMode: (mode: string) => setMode(mode),
}));

import type { RunEvent } from "../events";
import { currentLang } from "../state/lang";
import { agentDirectory } from "./agentDirectory";
import { MomentRow } from "./MomentList";
import { momentsOf } from "./moments";

const lang = currentLang();
const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

/** A run whose moments sit in DIFFERENT steps, on purpose: a handler that
 *  seeks one constant for every row has to be red, not merely lucky. */
const run: RunEvent[] = [
  ev({ type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1000 }),
  ev({ type: "turn_start", agentId: "main", turn: 1, ts: 1100 }),
  ev({ type: "text_delta", agentId: "main", text: "…", ts: 1150 }),
  ev({ type: "agent_spawn", agentId: "child_01OPAQUE", parentId: "main", task: "read", ts: 1200 }),
  ev({ type: "text_delta", agentId: "main", text: "…", ts: 1250 }),
  ev({ type: "error", agentId: "main", message: "the only failure", ts: 61000 }),
];

const moments = momentsOf(run);
const dir = agentDirectory(run);

/** The button React would have mounted, pulled out of the row's own element
 *  tree. Not a search of markup: the handler is the thing under test. */
function buttonOf(node: unknown): ReactElement<{ onClick?: () => void }> | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ children?: unknown; onClick?: () => void }>;
  if (el.type === "button") return el;
  const kids = el.props.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = buttonOf(kid);
    if (hit !== null) return hit;
  }
  return null;
}

/** Click row `i` the way a reader does, and hand back what the transport was
 *  told, in the order it was told. */
function click(i: number): { seeked: number[]; modes: string[]; seekFirst: boolean } {
  const row = MomentRow({ moment: moments[i], dir, lang, elapsedMs: null });
  const button = buttonOf(row);
  expect(button, `row ${i} must render a button`).not.toBeNull();
  const onClick = (button as ReactElement<{ onClick?: () => void }>).props.onClick;
  expect(onClick, `row ${i}'s button must carry a handler`).toBeTypeOf("function");
  (onClick as () => void)();
  const seekOrder = seek.mock.invocationCallOrder[0] ?? Infinity;
  const modeOrder = setMode.mock.invocationCallOrder[0] ?? Infinity;
  return {
    seeked: seek.mock.calls.map(([n]) => n),
    modes: setMode.mock.calls.map(([m]) => m),
    seekFirst: seekOrder < modeOrder,
  };
}

beforeEach(() => {
  seek.mockClear();
  setMode.mockClear();
});

describe("a moment row's click is the transport's own seek", () => {
  it("has moments in different steps, none of them the run's start", () => {
    // The premise the two bites below rest on. Without it `seek(0)` and
    // `seek(<any constant>)` could both pass by coincidence, and the suite
    // would be measuring the fixture rather than the handler.
    expect(moments.length).toBeGreaterThan(1);
    const cursors = moments.map((m) => m.cursor);
    expect(cursors).not.toContain(0);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it.each(moments.map((m, i) => [i, m.mark.kind] as const))(
    "seeks row %i (%s) to the cursor its own fold computed",
    (i) => {
      expect(click(i).seeked).toEqual([moments[i].cursor]);
    },
  );

  it("takes the transport off auto-play, or the landing is walked away from", () => {
    expect(click(0).modes).toEqual(["step"]);
  });

  it("stops the auto-play BEFORE it seeks, not after", () => {
    // Ordered the other way round the run keeps flowing across the seek and
    // the reader arrives somewhere else. A set of calls is not enough here.
    expect(click(0).seekFirst).toBe(false);
  });
});

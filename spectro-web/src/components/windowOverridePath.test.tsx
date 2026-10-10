// Card 390, review of 2026-09-24 (second round): the path from the ring's two
// buttons to App's handler, link by link.
//
// ContextRingWindowOverride.test.tsx pins the row's own presses, with handlers
// the test builds itself. The lines that join the row to the session were
// pinned by nothing: the popover's onSet and onClear, the ring handing its
// handler to the popover, and the composer block (card 463; the header before it) handing App's handler to
// the ring.
// With all of them dropped or made no-ops, and App's frame built but not
// sent, tsc and all 463 files stayed green (evidence 390/fix-2026-09-24/round2,
// 01-gap-mutations.diff and 03-gap-full-suite.log). The App.tsx line is pinned
// in windowOverrideSeam.drift.test.ts.
//
// HOW THIS FILE PRESSES A BUTTON WITHOUT A DOM. There is no jsdom in this
// suite. `drive` renders one probe component on React's server renderer and,
// inside that render, calls the components it is told to expand as plain
// functions, so their hooks run as hooks of the probe. A step that sets state
// there (opening the ring, typing) is a render-phase update: React runs the
// probe again with the new state, and the next step reads the tree of that
// pass. The probe also bumps its own counter after every step, so each step
// gets its own pass whether or not it set state. What a step presses is the
// handler the component built in that pass.
//
// React's server renderer refuses a pass with more hooks than the one before.
// Opening the ring adds the popover and its hooks, so the ring and the popover
// are never expanded in the same probe: a probe that opens the ring reads the
// popover's ELEMENT and its props, and a second probe renders that element.

import { afterEach, describe, expect, it } from "vitest";
import { isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerMeta } from "./ComposerMeta";
import { ContextPopover, ContextRing, WindowOverrideRow } from "./ContextRing";
import { contextGauge } from "./contextRingMath";
import type { ContextSnapshot } from "../state/reducer";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

type Handler = (tokens: number | null) => void;
type Props = {
  children?: ReactNode;
  className?: string;
  id?: string;
  value?: string;
  disabled?: boolean;
  onClick?: () => void;
  onChange?: (e: { target: { value: string } }) => void;
  onWindowOverride?: Handler | undefined;
};
type El = ReactElement<Props>;
type Step = (tree: El[]) => void;

/** Every element in a tree, outermost first, with the `expand` components run. */
function flatten(node: ReactNode, expand: ReadonlySet<unknown>): El[] {
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as El;
    out.push(el);
    if (expand.has(el.type)) {
      walk((el.type as (p: Props) => ReactNode)(el.props));
      return;
    }
    walk(el.props.children);
  };
  walk(node);
  return out;
}

/**
 * Renders `root` in a probe, with `expand` run as functions, and runs one step
 * per render pass.
 *
 * @return the tree of the pass after the last step
 * @throws Error when React stopped before every step ran
 */
function drive(root: ReactNode, expand: unknown[], steps: Step[]): El[] {
  const expanded = new Set(expand);
  let next = 0;
  let last: El[] = [];
  function Probe(): null {
    const [, bump] = useState(0);
    const tree = flatten(root, expanded);
    if (next < steps.length) {
      steps[next++](tree);
      bump((n) => n + 1);
    } else {
      last = tree;
    }
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (next !== steps.length) throw new Error(`ran ${next} of ${steps.length} steps`);
  return last;
}

/** The one host element of a tag with a class (or an id), or a failure naming it. */
function one(tree: El[], tag: string, match: { className?: string; id?: string }): El {
  const found = tree.filter(
    (el) =>
      el.type === tag &&
      (match.className === undefined || el.props.className === match.className) &&
      (match.id === undefined || el.props.id === match.id),
  );
  if (found.length !== 1) {
    throw new Error(`expected one <${tag} ${JSON.stringify(match)}> in this pass, found ${found.length}`);
  }
  return found[0];
}

/** The one element of a component in a tree. */
function only(tree: El[], component: unknown): El {
  const found = tree.filter((el) => el.type === component);
  expect(found).toHaveLength(1);
  return found[0];
}

const openRing: Step = (tree) => one(tree, "button", { className: "context-ring" }).props.onClick?.();

const type =
  (value: string): Step =>
  (tree) =>
    one(tree, "input", { id: "context-window-override" }).props.onChange?.({ target: { value } });

/** A click as a browser delivers it: none at all on a disabled button. */
const press =
  (className: string): Step =>
  (tree) => {
    const button = one(tree, "button", { className });
    if (button.props.disabled !== true) button.props.onClick?.();
  };

const snapshot = (extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  turn: 3,
  messages: 12,
  estimatedTokens: 8100,
  threshold: 175_257,
  thresholdSource: "window",
  contextWindow: 250_368,
  parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
  ...extra,
});

/** A run on the window the operator set: what the server answers a set of 512,000 with. */
const SET = snapshot({ threshold: 358_400, thresholdSource: "window_override", contextWindow: 512_000 });

/** What a handler was called with, in order. */
function recorder(): { calls: (number | null)[]; handler: Handler } {
  const calls: (number | null)[] = [];
  return { calls, handler: (tokens) => void calls.push(tokens) };
}

const POPOVER = [ContextPopover, WindowOverrideRow];

const popover = (context: ContextSnapshot, handler: Handler | undefined) => {
  const gauge = contextGauge(context.threshold, context.contextWindow, context.thresholdSource);
  return (
    <ContextPopover
      lastInputTokens={42_063}
      context={context}
      gauge={gauge}
      shownPct={Math.round((42_063 / gauge.denominator.value) * 100)}
      onWindowOverride={handler}
      aiCredits={null}
    />
  );
};

const ring = (context: ContextSnapshot, handler: Handler | undefined) => (
  <ContextRing lastInputTokens={42_063} context={context} onWindowOverride={handler} aiCredits={null} />
);

// Card 463: the ring sits in the block under the composer now.
const meta = (liveView: boolean, handler: Handler) => (
  <ComposerMeta
    provider="ollama"
    model=""
    status="open"
    onApplyProvider={() => {}}
    liveView={liveView}
    lastInputTokens={42_063}
    aiCredits={null}
    context={SET}
    onWindowOverride={handler}
  />
);

/** The popover the composer block's ring opens, as the ring builds it. */
function openedFromMeta(liveView: boolean, handler: Handler): El {
  return only(drive(meta(liveView, handler), [ComposerMeta, ContextRing], [openRing]), ContextPopover);
}

describe("the popover's buttons call the popover's handler (ContextPopover)", () => {
  it("Set sends the window typed and empties the input", () => {
    const r = recorder();
    const after = drive(popover(snapshot(), r.handler), POPOVER, [
      type("512000"),
      press("context-override-apply"),
    ]);
    expect(r.calls).toEqual([512_000]);
    expect(one(after, "input", { id: "context-window-override" }).props.value).toBe("");
  });

  it("the typing reaches the input the Set button reads", () => {
    // The positive half of the case above: without it, a driver whose typing
    // never landed would also leave an empty input after Set.
    const after = drive(
      popover(snapshot(), () => {}),
      POPOVER,
      [type("512000")],
    );
    expect(one(after, "input", { id: "context-window-override" }).props.value).toBe("512000");
    expect(one(after, "button", { className: "context-override-apply" }).props.disabled).toBe(false);
  });

  it("Clear sends the clear once a window is set", () => {
    const r = recorder();
    drive(popover(SET, r.handler), POPOVER, [press("context-override-clear")]);
    expect(r.calls).toEqual([null]);
  });
});

describe("the ring hands its handler to the popover it opens (ContextRing)", () => {
  it("the opened popover calls the ring's handler", () => {
    const r = recorder();
    const opened = only(drive(ring(snapshot(), r.handler), [ContextRing], [openRing]), ContextPopover);
    opened.props.onWindowOverride?.(512_000);
    opened.props.onWindowOverride?.(null);
    expect(r.calls).toEqual([512_000, null]);
  });
});

describe("the composer block hands App's handler to the ring in the live view only (ComposerMeta)", () => {
  it("a Set pressed in the ring reaches the handler App passed", () => {
    const r = recorder();
    drive(openedFromMeta(true, r.handler), POPOVER, [type("512000"), press("context-override-apply")]);
    expect(r.calls).toEqual([512_000]);
  });

  it("a Clear pressed in the ring reaches it too", () => {
    const r = recorder();
    drive(openedFromMeta(true, r.handler), POPOVER, [press("context-override-clear")]);
    expect(r.calls).toEqual([null]);
  });

  it("a replay opens the same popover with no row in it", () => {
    const r = recorder();
    const opened = openedFromMeta(false, r.handler);
    expect(opened.props.onWindowOverride).toBeUndefined();
    const inside = drive(opened, POPOVER, []);
    expect(one(inside, "p", { className: "context-line tabular" }).props.children).toBeDefined();
    expect(inside.filter((el) => el.type === "input")).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

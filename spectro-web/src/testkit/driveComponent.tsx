// Drives a component that keeps state, without a DOM (card 386).
//
// There is no jsdom in this suite. `drive` renders one probe component on
// React's server renderer and, inside that render, calls the components it is
// told to expand as plain functions, so their hooks run as hooks of the probe.
// A step that sets state there (typing into a field) is a render-phase update:
// React runs the probe again with the new state, and the next step reads the
// tree of that pass. The probe also bumps its own counter after every step, so
// each step gets its own pass whether or not it set state. What a step presses
// is the handler the component built in that pass.
//
// The technique is the one windowOverridePath.test.tsx wrote for card 390,
// lifted here so more than one file can use it.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

import { isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The props a step may read or press on a host element. */
export type HostProps = {
  children?: ReactNode;
  value?: string | number;
  min?: number;
  "aria-invalid"?: boolean;
  onChange?: (e: { target: { value: string } }) => void;
  onBlur?: () => void;
  onClick?: () => void;
  [attribute: string]: unknown;
};
export type El = ReactElement<HostProps>;
export type Step = (tree: El[]) => void;

/** Every element in a tree, outermost first, with the `expand` components run. */
function flatten(node: ReactNode, expand: ReadonlySet<unknown>): El[] {
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child as ReactNode);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as El;
    out.push(el);
    if (expand.has(el.type)) {
      walk((el.type as (p: HostProps) => ReactNode)(el.props));
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
 * @param root   the element to render
 * @param expand the components whose hooks the probe hosts
 * @param steps  what to do in each pass, in order
 * @return the tree of the pass after the last step
 * @throws Error when React stopped before every step ran
 */
export function drive(root: ReactNode, expand: unknown[], steps: Step[]): El[] {
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

/** The one host `<input>` in a pass, or a failure naming how many there were. */
export function theInput(tree: El[]): El {
  const inputs = tree.filter((el) => el.type === "input");
  if (inputs.length !== 1) throw new Error(`expected one <input> in this pass, found ${inputs.length}`);
  return inputs[0];
}

/** A step that types `value` into the one input, as a change event delivers it. */
export const typeInto =
  (value: string): Step =>
  (tree) =>
    theInput(tree).props.onChange?.({ target: { value } });

/** A step that moves the focus out of the one input. */
export const leave: Step = (tree) => theInput(tree).props.onBlur?.();

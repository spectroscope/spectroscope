// Card 386: all thirteen number fields of the settings page, emptied.
//
// The card counted 13 keys saved through 8 lines of `Number(e.target.value)`,
// in two components. Each of those fields is found here on the element tree the
// two components return, and each is typed into with an empty value through
// the handler the field built. A field that still saved a zero turns this red
// by name.
//
// Card 394 adds a fourteenth, subagentBudgetTokens, with the floor of its
// sibling subagentBudgetSeconds.

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import { DockWidthSettings } from "./DockWidthSettings";
import { NumberField } from "./settingsNumberField";
import { OriginRow } from "./settingsOrigin";
import { drive, typeInto } from "../testkit/driveComponent";
import type { SettingsView } from "../state/serverSettings";

/** The card's thirteen keys and card 394's one with their floors, as the
 *  server sends them. */
const FLOORS: Record<string, number> = {
  commandTimeoutSeconds: 1,
  subagentBudgetSeconds: 1,
  subagentBudgetTokens: 1,
  maxTurns: 1,
  maxTokens: 1,
  maxQuestionOptions: 1,
  maxQuestionChars: 1,
  dockMaxWidth: 260,
  progressGuardWrites: 0,
  progressGuardFailures: 0,
  progressGuardPlanTurns: 0,
  continuationBudget: 0,
  questionsPerRun: 0,
  chatReserveWidth: 0,
};

const VIEW: SettingsView = {
  effective: Object.fromEntries(Object.keys(FLOORS).map((k) => [k, 500])),
  origins: {},
  layers: {},
  files: {},
  workspace: null,
  floors: FLOORS,
};

type Props = Record<string, unknown>;

/** The components the walk stops at: they are what this file looks for, and
 *  NumberField keeps state, so it is only ever run inside `drive`. */
const LEAVES: ReadonlySet<unknown> = new Set([NumberField, OriginRow]);

/** Every element in a tree, outermost first. Every other component is run as
 *  a function, because the guard's three counts are drawn by a component of
 *  their own inside ProgressGuardSettings (none of those uses a hook). */
function elementsIn(node: ReactNode): ReactElement<Props>[] {
  const found: ReactElement<Props>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n as ReactNode[]) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Props>;
    found.push(el);
    if (typeof el.type === "function" && !LEAVES.has(el.type)) {
      walk((el.type as (p: Props) => ReactNode)(el.props));
      return;
    }
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return found;
}

/** Both components' trees, with every patch their handlers send. */
function page(saved: Record<string, unknown>[]): ReactElement<Props>[] {
  const onSave = (patch: Record<string, unknown>) => saved.push(patch);
  return [
    ...elementsIn(ProgressGuardSettings({ anchorId: "p", view: VIEW, lang: "en", onSave })),
    ...elementsIn(DockWidthSettings({ view: VIEW, lang: "en", onSave })),
  ];
}

describe("the fourteen number fields of the settings page", () => {
  it("are drawn by the one number field, each under its own key", () => {
    const fields = page([])
      .filter((el) => el.type === NumberField)
      .map((el) => el.props.field as string);
    expect(fields.sort()).toEqual(Object.keys(FLOORS).sort());
  });

  it("each send nothing when emptied", () => {
    const tree = page([]);
    for (const el of tree.filter((e) => e.type === NumberField)) {
      const saved: Record<string, unknown>[] = [];
      const field = el.props.field as string;
      // The element as the page built it, with its own onSave swapped for a
      // recorder: the view, the field and the language stay the page's.
      const probe = cloneElement(el, { onSave: (p: Record<string, unknown>) => saved.push(p) });
      drive(probe, [NumberField], [typeInto("")]);
      expect(saved, `${field} saved something for an empty field`).toEqual([]);
    }
  });

  it("each save a number at their floor under their own key", () => {
    // The positive half: a field wired to nothing would pass the case above.
    for (const el of page([]).filter((e) => e.type === NumberField)) {
      const saved: Record<string, unknown>[] = [];
      const field = el.props.field as string;
      const probe = cloneElement(el, { onSave: (p: Record<string, unknown>) => saved.push(p) });
      drive(probe, [NumberField], [typeInto(String(FLOORS[field]))]);
      expect(saved, field).toEqual([{ [field]: FLOORS[field] }]);
    }
  });

  it("hand the page's own onSave to each field", () => {
    // The two cases above swap the recorder in. This one presses the handler
    // the page gave the field, so a field wired to a no-op cannot hide there.
    for (const el of page([]).filter((e) => e.type === NumberField)) {
      const saved: Record<string, unknown>[] = [];
      const field = el.props.field as string;
      const fromPage = page(saved).find((e) => e.type === NumberField && e.props.field === field);
      drive(fromPage as ReactElement, [NumberField], [typeInto(String(FLOORS[field] + 1))]);
      expect(saved, field).toEqual([{ [field]: FLOORS[field] + 1 }]);
    }
  });

  it("keep an origin row under each field", () => {
    const rows = page([])
      .filter((el) => el.type === OriginRow)
      .map((el) => el.props.field as string);
    for (const field of Object.keys(FLOORS)) expect(rows, field).toContain(field);
  });
});

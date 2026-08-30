// Card 318, the half the first version of this card could not reach: what the
// row RENDERS, and which door each of its two buttons presses.
//
// The gap, measured by a reviewer on the shipped commit: the requirement was
// four `toContain` searches over the source of `loadFromStore`, and rewiring the
// row's own press to the session door — one token, `state.plan.door` →
// `"session"` — left `npx tsc -b` at 0 and all 5731 tests passing. A guard that
// asks "does the line still say that?" greps the line; this one builds the
// element and calls the handler.
//
// There is no DOM in this suite (no jsdom in vite.config.ts), so nothing is
// clicked. `renderToStaticMarkup` gives the visible half — the label, the escape
// and its words in both languages — and the element tree gives the wiring:
// React elements are plain objects, so a button's `onClick` can be found and
// invoked without a browser.

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StoreRow } from "./StoreRow";
import { rowState, type StoreLimits, type TranscriptRow } from "../import/rowState";
import type { TranscriptFacts } from "../import/transcriptFacts";
import type { StoreDoor } from "../import/storeDoor";
import { dict, type Lang } from "../i18n/i18n";

const LIMITS: StoreLimits = { limitBytes: 128 * 1024 * 1024 };

const row = (over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  path: "-Users-x-repo/s1.jsonl",
  project: "-Users-x-repo",
  file: "s1.jsonl",
  size: 3 * 1024 * 1024,
  modifiedAt: 1,
  loadable: true,
  ...over,
});

const facts = (over: Partial<TranscriptFacts> = {}): TranscriptFacts => ({
  path: "-Users-x-repo/s1.jsonl",
  models: ["test-model"],
  workflowCalls: 1,
  subagents: 0,
  workflowAgents: 13,
  ...over,
});

/**
 * The row as the dialog builds it, with the real `rowState` deciding the plan.
 *
 * @param opts what differs from the default row: its facts (undefined means
 *        "the batch has not landed"), the language, whether a load is in flight
 * @returns the element and the doors each press asked for, in press order
 */
function build(
  opts: {
    facts?: TranscriptFacts;
    over?: Partial<TranscriptRow>;
    lang?: Lang;
    busy?: boolean;
  } = {},
): { element: ReactElement; pressed: StoreDoor[] } {
  const pressed: StoreDoor[] = [];
  const state = rowState(row(opts.over), LIMITS, opts.lang ?? "en", opts.facts);
  const element = (
    <StoreRow
      tr={row(opts.over)}
      state={state}
      lang={opts.lang ?? "en"}
      now={1}
      busy={opts.busy ?? false}
      loadingThis={false}
      onOpen={(door) => pressed.push(door)}
    />
  );
  return { element, pressed };
}

/** Every button in an element tree, outermost first. */
function buttons(
  node: ReactNode,
): ReactElement<{ onClick?: () => void; className?: string; disabled?: boolean }>[] {
  const found: ReactElement<{ onClick?: () => void; className?: string; disabled?: boolean }>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode; className?: string }>;
    // A component element is a call that has not happened yet. Evaluating it
    // here is what lets this suite reach the handlers without a renderer.
    if (typeof el.type === "function") {
      walk((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.type === "button") {
      found.push(el as ReactElement<{ onClick?: () => void; className?: string; disabled?: boolean }>);
    }
    walk(el.props.children);
  };
  walk(node);
  return found;
}

/** The rendered row as markup, for the half a handler cannot show. */
const html = (element: ReactElement): string => renderToStaticMarkup(element);

describe("the row's own press takes the door its plan named", () => {
  it("a session with agents beside it: the press asks for the RUN", () => {
    // The card in one assertion, on the surface the owner actually clicks.
    // Bitten by hand: `onClick={() => props.onOpen("session")}` on the row's
    // button turns this red, which is the edit that was green before StoreRow
    // existed.
    const { element, pressed } = build({ facts: facts() });
    buttons(element)[0].props.onClick?.();
    expect(pressed).toEqual(["run"]);
  });

  it("a session with nothing beside it: the press asks for the FILE", () => {
    const { element, pressed } = build({ facts: facts({ workflowAgents: 0, subagents: 0 }) });
    buttons(element)[0].props.onClick?.();
    expect(pressed).toEqual(["session"]);
  });

  it("facts still in flight: the press asks for the run, and the escape is there", () => {
    // The window a reviewer found. `doorFor` deliberately takes the run door
    // before the facts land — the list never waits for them — so the first
    // press after the dialog opens can pull a whole run. The LABEL is withheld
    // (no count has been measured) but the way out must not be.
    const { element, pressed } = build({ facts: undefined });
    const both = buttons(element);
    expect(both, "the escape must be offered even with no count to print").toHaveLength(2);
    both[0].props.onClick?.();
    both[1].props.onClick?.();
    expect(pressed).toEqual(["run", "session"]);
    expect(html(element)).not.toContain(dict["imp.run.brings"].en.split("{")[0].trim());
  });
});

describe("what the row says before the press", () => {
  it("names what the press is about to bring, with the plan's own count", () => {
    // AC6/AC7: told BEFORE the click, and off the same number the plan carries,
    // so the row and the sentence cannot disagree. Derived — move the fact and
    // the rendered number moves with it.
    for (const n of [1, 13, 245]) {
      expect(html(build({ facts: facts({ workflowAgents: n }) }).element)).toContain(String(n));
    }
  });

  it("says what the press will FETCH, not what the session file weighs", () => {
    // The number that was there before this case understated the click tenfold
    // on the operator's own session: the row printed the session file's 11.4 MB
    // and the press pulled 105.8. Both are now on the line, and the run's figure
    // is the server's own weigh of the bundle — the same one a 413 quotes.
    const rendered = html(
      build({ facts: facts({ workflowAgents: 245, runs: 49, runBytes: 110_904_820 }) }).element,
    );
    expect(rendered).toContain("245");
    expect(rendered, "how many runs are in there").toContain("49");
    expect(rendered, "what the press costs").toContain("105.8 MB");
    expect(rendered, "and the session file's own size stays where it was").toContain("3.0 MB");
  });

  it("says only what it knows: a server that does not weigh the run prints no size", () => {
    // `runs` and `runBytes` are absent from an older server, and absent means
    // "did not say", never zero. A row that printed "0 runs · 1 kB" would be
    // inventing the one number this whole case exists to make honest.
    const rendered = html(build({ facts: facts({ workflowAgents: 13 }) }).element);
    expect(rendered).toContain("13");
    expect(rendered).not.toContain("0 runs");
    expect(rendered).not.toContain("1 kB");
  });

  it("offers the escape, labelled, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      expect(html(build({ facts: facts(), lang }).element)).toContain(dict["imp.run.only"][lang]);
    }
    // And the label of the run door itself, which is the promise the escape is
    // an alternative to.
    expect(html(build({ facts: facts(), lang: "de" }).element)).toContain(
      dict["imp.run.brings"].de.split("{")[0].trim(),
    );
  });

  it("says neither for a session that has nothing beside it", () => {
    const rendered = html(build({ facts: facts({ workflowAgents: 0, subagents: 0 }) }).element);
    expect(rendered).not.toContain(dict["imp.run.only"].en);
    expect(rendered).not.toContain("import-store-brings");
  });

  it("a refused row is disabled, keeps its reason and offers no run door at all", () => {
    const { element } = build({ over: { loadable: false, size: 200 * 1024 * 1024 }, facts: facts() });
    expect(buttons(element)).toHaveLength(1);
    expect(buttons(element)[0].props.disabled).toBe(true);
    expect(html(element)).toContain("200.0 MB");
  });
});

describe("one click, one load", () => {
  it("both buttons go dead while a store load is in flight", () => {
    // The run door can carry a hundred megabytes, and the browser is then busy
    // for tens of seconds. Measured by a reviewer on the shipped commit: two
    // presses 402 ms apart fired two whole bundles.
    const { element } = build({ facts: facts(), busy: true });
    for (const button of buttons(element)) {
      expect(button.props.disabled, "a row must not be pressable twice").toBe(true);
    }
  });
});

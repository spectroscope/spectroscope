// The popover of the session list's options, OPEN, read off its markup
// (card 555 review).
//
// Removing the minimal button from the panel left every test green: the
// store's list was pinned, the panel that maps it was not. This opens the
// panel with the trigger's own click handler (testkit/driveComponent, no DOM)
// and reads the radio group it draws.

import { describe, expect, it } from "vitest";
import { drive, type El } from "../testkit/driveComponent";
import { SessionListOptions } from "./SessionListOptions";
import { __resetForTests, __setTestHooks, setDensity, type Density } from "../state/density";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

const written = new Map<string, string>();
__setTestHooks({
  get: (k) => written.get(k) ?? null,
  set: (k, v) => void written.set(k, v),
});
__resetForTests();

/** The text a host element carries, children flattened. */
function text(el: El): string {
  const kids = el.props.children;
  const flat = (n: unknown): string =>
    Array.isArray(n) ? n.map(flat).join("") : typeof n === "string" || typeof n === "number" ? String(n) : "";
  return flat(kids);
}

/** The panel, opened by a click on its trigger, at one stored density. */
function openAt(at: Density, lang: Lang): El[] {
  setLang(lang);
  setDensity(at);
  const tree = drive(
    <SessionListOptions />,
    [SessionListOptions],
    [
      (pass) => {
        const trigger = pass.find((el) => el.type === "button" && el.props.className === "sess-opts-btn");
        if (trigger === undefined) throw new Error("no trigger in the closed panel");
        trigger.props.onClick?.();
      },
    ],
  );
  setDensity("normal");
  setLang("en");
  return tree;
}

const radios = (tree: El[]): El[] => tree.filter((el) => el.props.role === "radio");

describe("the open options panel (card 555)", () => {
  it("offers three radio buttons in the order minimal, normal, extended", () => {
    const tree = openAt("normal", "en");
    expect(tree.some((el) => el.props.role === "radiogroup")).toBe(true);
    expect(radios(tree).map(text)).toEqual(["minimal", "normal", "extended"]);
    expect(radios(tree).map((el) => el.props.title)).toEqual([
      "the name and its dot",
      "name, folder and state",
      "with time, turns and tokens",
    ]);
  });

  it("labels the three in German as well", () => {
    expect(radios(openAt("normal", "de")).map(text)).toEqual(["minimal", "normal", "erweitert"]);
  });

  it("checks exactly the stored value, whichever it is", () => {
    for (const at of ["minimal", "normal", "extended"] as const) {
      const checked = radios(openAt(at, "en")).map((el) => el.props["aria-checked"]);
      const expected = (["minimal", "normal", "extended"] as const).map((d) => d === at);
      expect(checked, at).toEqual(expected);
    }
  });

  it("is closed until the trigger is pressed", () => {
    // The positive half above needs this one: a panel that rendered open on
    // its own would pass it without the click doing anything.
    const closed = drive(<SessionListOptions />, [SessionListOptions], []);
    expect(radios(closed)).toHaveLength(0);
  });
});

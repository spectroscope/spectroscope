// Card 407, criterion 7: the slash picker still works around its heading.
//
// Card 407 changes how far the SKILLS heading sits above the first row, and
// only that. This file pins what the picker does, so the change can be shown
// to leave it alone: the markup of the three states the popover can be in (a
// list, no skills at all, no match), the arrow keys moving the one focus
// index, and a pick by key and by pointer handing back the completed draft.
//
// No DOM in this suite (house rule). The markup is rendered statically, and
// the keys are pressed through drive(), which runs the picker's hooks inside a
// probe and hands each step the handler of that render pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSlashPicker, type SlashPicker } from "./SlashPicker";
import { __resetSkillList, loadSkills } from "../state/skillList";
import { slashQueryAt, tokenInsert, type SkillOption } from "../state/slashCommands";
import { drive, type El } from "../testkit/driveComponent";
import { setLang } from "../state/lang";

const SKILLS: SkillOption[] = [
  {
    name: "superpowers:brainstorming",
    folder: "brainstorming",
    pack: "superpowers",
    description: "Explores intent before any implementation.",
    disabled: false,
  },
  {
    name: "verification",
    folder: "verification",
    pack: null,
    description: "Check the work before calling it done.",
    disabled: false,
  },
  { name: "zeta", folder: "zeta", pack: null, description: "The last row.", disabled: false },
];

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Seeds the module store the picker reads with what the server would answer. */
async function serve(skills: SkillOption[]): Promise<void> {
  __resetSkillList();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ skills }),
    } as unknown as Response),
  );
  loadSkills();
  await flush();
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  setLang("en");
});

/** What the picker handed back, one entry per pick. */
let picked: { text: string; caret: number }[] = [];
const record = (text: string, caret: number): void => {
  picked.push({ text, caret });
};

/** The picker as the composer mounts it: the field hands every key to the
 *  picker first, and the popover hangs in the same column. */
function Picker({ draft }: { draft: string }) {
  const slash = useSlashPicker(draft, draft.length, true, record);
  return (
    <div className="composer-inner">
      <textarea value={draft} readOnly onKeyDown={slash.handleKey} />
      {slash.node}
    </div>
  );
}

/** The popover's own markup, from its opening tag to the end. */
function popOf(html: string): string {
  const at = html.indexOf('<div class="wsg-pop slash-pop"');
  expect(at, "the popover is in the markup").toBeGreaterThan(-1);
  return html.slice(at);
}

/** A key as the composer forwards it: the picker reads `key` and may prevent. */
function key(name: string): KeyboardEvent {
  return { key: name, preventDefault: () => {} } as unknown as KeyboardEvent;
}

/** Presses `name` on the field's handler as this pass built it.
 *  @return what the picker answered: true when it consumed the key */
function keyDown(tree: El[], name: string): boolean {
  const field = tree.find((el) => el.type === "textarea");
  if (field === undefined) throw new Error("the composer field is not in this pass");
  return (field.props.onKeyDown as SlashPicker["handleKey"])(key(name));
}

/** A step that presses `name`. */
const press =
  (name: string) =>
  (tree: El[]): void => {
    keyDown(tree, name);
  };

/** The name on the one option marked selected in a pass. */
function focused(tree: El[]): string {
  const on = tree.filter((el) => el.props.role === "option" && el.props["aria-selected"] === true);
  expect(on.length, "exactly one row is focused").toBe(1);
  return nameOf(on[0]);
}

/** The skill name a row button shows in its .slash-name span. */
function nameOf(row: El): string {
  const kids = ([] as unknown[]).concat(row.props.children);
  const span = kids.find(
    (k): k is El => typeof k === "object" && k !== null && (k as El).props?.className === "slash-name mono",
  );
  return String(span?.props.children);
}

/** What a pick of `name` on `draft` writes back, from the rule the picker uses. */
function completed(draft: string, name: string): { text: string; caret: number } {
  const at = slashQueryAt(draft, draft.length);
  const skill = SKILLS.find((s) => s.name === name);
  if (at === null || skill === undefined) throw new Error(`no completion for ${name} on ${draft}`);
  return tokenInsert(draft, at, draft.length, skill);
}

describe("the three states the popover draws", () => {
  beforeEach(() => {
    picked = [];
  });

  it("a list: the heading first, then one row per match, the first one focused", async () => {
    await serve(SKILLS);
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    // The heading is the popover's first child. The stylesheet's
    // `.settings-label:first-child` rule is what zeroes its top margin, and
    // card 407 changes only the bottom one.
    expect(pop).toMatch(/^<div class="wsg-pop slash-pop"[^>]*><div class="settings-label">Skills<\/div><ul/);
    expect(pop.split("<li").length - 1).toBe(3);
    expect(pop).toMatch(
      /aria-selected="true" class="slash-row slash-row--on"[^>]*><span class="slash-name mono">superpowers:brainstorming</,
    );
    expect(pop.match(/slash-row--on/g)?.length).toBe(1);
    expect(pop).toContain('<p class="settings-note slash-hint">');
  });

  it("no skills installed: the heading, the empty note, no list", async () => {
    await serve([]);
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(pop).toMatch(
      /^<div class="wsg-pop slash-pop"[^>]*><div class="settings-label">Skills<\/div><p class="settings-note">No skills installed<\/p>/,
    );
    expect(pop).not.toContain("<ul");
  });

  it("no match: the heading, the query quoted back, no list", async () => {
    await serve(SKILLS);
    const pop = popOf(renderToStaticMarkup(<Picker draft="/qqqq" />));
    expect(pop).toMatch(
      /^<div class="wsg-pop slash-pop"[^>]*><div class="settings-label">Skills<\/div><p class="settings-note">No skill matches “qqqq”<\/p>/,
    );
    expect(pop).not.toContain("<ul");
  });

  it("writes the no-match and the empty note in German too", async () => {
    setLang("de");
    await serve(SKILLS);
    expect(renderToStaticMarkup(<Picker draft="/qqqq" />)).toContain("Kein Skill passt zu „qqqq“");
    await serve([]);
    expect(renderToStaticMarkup(<Picker draft="/" />)).toContain("Keine Skills installiert");
  });
});

describe("the keys and the pointer", () => {
  beforeEach(async () => {
    picked = [];
    await serve(SKILLS);
  });

  it("ArrowDown moves the focus one row down", () => {
    const tree = drive(<Picker draft="/" />, [Picker], [press("ArrowDown")]);
    expect(focused(tree)).toBe("verification");
  });

  it("ArrowUp from the first row wraps to the last", () => {
    const tree = drive(<Picker draft="/" />, [Picker], [press("ArrowUp")]);
    expect(focused(tree)).toBe("zeta");
  });

  it("Enter picks the focused row and hands back the completed draft", () => {
    drive(<Picker draft="/" />, [Picker], [press("ArrowDown"), press("Enter")]);
    expect(picked).toEqual([completed("/", "verification")]);
  });

  it("a click picks the row it lands on", () => {
    const click = (tree: El[]): void => {
      const row = tree.find((el) => el.props.role === "option" && nameOf(el) === "zeta");
      expect(row, "the zeta row is drawn").toBeDefined();
      row?.props.onClick?.();
    };
    drive(<Picker draft="/" />, [Picker], [click]);
    expect(picked).toEqual([completed("/", "zeta")]);
  });

  it("with no match, Enter stays the composer's", () => {
    const answers: boolean[] = [];
    drive(<Picker draft="/qqqq" />, [Picker], [(tree) => void answers.push(keyDown(tree, "Enter"))]);
    expect(answers).toEqual([false]);
    expect(picked).toEqual([]);
  });
});

// Card 588, fix round (I2): Escape puts away what is on offer now and nothing
// later. A command's template that Escape put away stays away while the draft
// is a command, and a skill list that Escape put away stays away while its
// token is typed; a new skill token later in the same message opens its list
// again (card 247).
//
// The picker is hosted across time by HookHost, so its effects run as React
// runs them; drive() cannot show this, because effects never run on the server
// renderer. Typing goes one character at a time, as a person types.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type KeyboardEvent, type ReactNode } from "react";
import { HookHost } from "../testkit/hookHost";
import { useSlashPicker, type SlashPicker } from "./SlashPicker";
import { __resetSkillList, loadSkills } from "../state/skillList";
import type { SkillOption } from "../state/slashCommands";
import { __resetCommandList, __setCommandRows } from "../state/commandList";
import { coreCommandRows } from "../testkit/commandRows";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const SKILLS: SkillOption[] = [
  { name: "verification", folder: "verification", pack: null, description: "Check it.", disabled: false },
];

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ skills: SKILLS }),
    } as unknown as Response),
  );
  loadSkills();
  await new Promise((r) => setTimeout(r, 0));
  __setCommandRows(coreCommandRows());
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __resetCommandList();
});

/** Every text in a node, components left out. */
function texts(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (isValidElement(node)) {
    if (typeof node.type === "function") return [];
    return texts((node.props as { children?: ReactNode }).children);
  }
  return [];
}

/** A composer field over the picker, typed into one character at a time. */
function composer() {
  let draft = "";
  let caret = 0;
  const host = new HookHost<SlashPicker>(() =>
    useSlashPicker(
      draft,
      caret,
      true,
      (text, at) => {
        draft = text;
        caret = at;
      },
      () => {},
    ),
  );
  return {
    typeOn(more: string): void {
      for (const ch of more) {
        draft += ch;
        caret = draft.length;
        host.invalidate();
      }
    },
    escape(): boolean {
      return host.value.handleKey({ key: "Escape", preventDefault: () => {} } as unknown as KeyboardEvent);
    },
    shown(): string {
      return texts(host.value.node).join(" | ");
    },
    open(): boolean {
      return host.value.node !== null;
    },
    done(): void {
      host.unmount();
    },
  };
}

describe("Escape in the slash picker (card 588, fix round)", () => {
  it("puts away the command list, and a skill token later in the message opens its list", () => {
    const c = composer();
    c.typeOn("/lo");
    expect(c.shown(), "premise: /loop is on offer").toContain("/loop");
    expect(c.escape()).toBe(true);
    expect(c.open()).toBe(false);
    c.typeOn("op 5m check /ver");
    expect(c.shown()).toContain("verification");
    c.done();
  });

  it("puts away the template while a prompt is typed, and a later skill token opens its list", () => {
    const c = composer();
    c.typeOn("/loop 5m check");
    expect(c.shown(), "premise: the template is up").toContain("/loop [interval] <prompt>");
    expect(c.escape()).toBe(true);
    expect(c.open()).toBe(false);
    c.typeOn(" the");
    expect(c.open(), "the template stays away while the command's words go on").toBe(false);
    c.typeOn(" /ver");
    expect(c.shown()).toContain("verification");
    expect(c.shown(), "the template stays away").not.toContain("/loop [interval] <prompt>");
    c.done();
  });

  it("does the same after /graph ask", () => {
    const c = composer();
    c.typeOn("/graph ask who");
    expect(c.shown(), "premise: the template is up").toContain("/graph ask <question>");
    c.escape();
    c.typeOn(" /ver");
    expect(c.shown()).toContain("verification");
    c.done();
  });

  it("keeps a skill list it put away closed while the same token is typed", () => {
    const c = composer();
    c.typeOn("tidy /ver");
    expect(c.shown(), "premise: the skill is on offer").toContain("verification");
    c.escape();
    c.typeOn("i");
    expect(c.open()).toBe(false);
    c.done();
  });
});

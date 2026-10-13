// Card 554 fix round 3, read off the stylesheets (no DOM in this suite).
//
// Item 2, criterion 8f: a prompt a playbook step sent must look like the
// playbook's and not like the owner's. chat.css hides every user turn's
// eyebrow from the eye (`.user-turn .eyebrow` is screen-reader only), so a
// class and a label in the markup alone change nothing on the screen. This
// resolves the cascade for the two class lists, the owner's turn and the
// playbook's, over every rule in every stylesheet whose selector can match
// them, and asks for the values that decide what is seen.
//
// Item 5: the "Asked: ..." line of the start sheet sits between the head and
// the body and lines up with the title, on wide and on narrow screens.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments as code, read, rules } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SHEETS = srcFiles(ROOT)
  .filter((p) => p.endsWith(".css"))
  .map((p) => ({ rel: p.slice(ROOT.length), css: code(srcText(p)) }));

/** The classes of one compound selector, or null when it names more than classes. */
function classesOf(compound: string): string[] | null {
  if (!/^(\.[A-Za-z0-9_-]+)+$/.test(compound)) return null;
  return compound.slice(1).split(".");
}

/**
 * The declarations that reach an element with `own` classes inside an element
 * with `outer` classes, from rules made of classes only, in cascade order:
 * fewer classes first, then source order. Rules inside an at-rule are left
 * out: only the unconditional cascade is resolved here.
 */
function cascade(outer: string[], own: string[]): Map<string, string> {
  const hits: { weight: number; at: number; body: string }[] = [];
  let at = 0;
  for (const sheet of SHEETS) {
    const atRules = [...sheet.css.matchAll(/@[a-z-]+[^{]*\{([^{}]*\{[^{}]*\})*[^{}]*\}/g)].map((m) => [
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
    ]);
    const lines = sheet.css.split("\n");
    for (const rule of rules(sheet.rel, sheet.css)) {
      at++;
      const offset = lines.slice(0, rule.line - 1).join("\n").length;
      if (atRules.some(([from, to]) => offset >= from && offset < to)) continue;
      const parts = rule.selector.split(/\s+/);
      if (parts.length > 2) continue;
      const last = classesOf(parts[parts.length - 1]);
      const first = parts.length === 2 ? classesOf(parts[0]) : [];
      if (last === null || first === null) continue;
      if (!last.every((c) => own.includes(c)) || !first.every((c) => outer.includes(c))) continue;
      hits.push({ weight: last.length + first.length, at, body: rule.body });
    }
  }
  hits.sort((a, b) => a.weight - b.weight || a.at - b.at);
  const out = new Map<string, string>();
  for (const hit of hits) {
    for (const decl of hit.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
  }
  return out;
}

const OWNER = ["user-turn"];
const PLAYBOOK = ["user-turn", "user-turn--playbook"];

/** True when the declarations leave the element visible to the eye. */
function seen(decls: Map<string, string>): boolean {
  const clip = decls.get("clip-path") ?? "none";
  const width = decls.get("width") ?? "auto";
  return clip === "none" && width !== "1px" && decls.get("position") !== "absolute";
}

describe("a playbook step's prompt in the chat (criterion 8f)", () => {
  it("premise: the owner's eyebrow is for screen readers only", () => {
    expect(seen(cascade(OWNER, ["eyebrow"]))).toBe(false);
  });

  it("shows its Playbook label", () => {
    const label = cascade(PLAYBOOK, ["eyebrow"]);
    expect(seen(label), JSON.stringify([...label])).toBe(true);
  });

  it("drops the owner's fill and draws a line of its own, with theme tokens", () => {
    const owner = cascade([], OWNER);
    const playbook = cascade([], PLAYBOOK);
    expect(playbook.get("background"), "not the owner's bubble").not.toBe(owner.get("background"));
    const line = playbook.get("border-left") ?? "";
    expect(line, "a line on its left").toMatch(/solid var\(--[a-z-]+\)/);
    for (const [prop, value] of playbook) {
      if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(value)) throw new Error(`${prop}: ${value} is no token`);
    }
  });
});

describe("the task line of the start sheet (fix round 3, item 5)", () => {
  const css = code(read("./playbook-run.css", import.meta.url));
  const of = (selector: string) => rules("playbook-run.css", css).filter((r) => r.selector === selector);
  const inline = (body: string): string | null => {
    const m = /padding:\s*([^;]+);/.exec(body);
    if (m === null) return null;
    const p = m[1].trim().split(/\s+/);
    return p.length === 1 ? p[0] : p[1];
  };

  it("lines up with the title: the same side padding as the sheet's head", () => {
    const [head] = of(".pb-sheet-head").filter((r) => !r.body.includes("padding-left"));
    const [task] = of(".pb-sheet-task").filter((r) => !r.body.includes("padding-left"));
    expect(inline(head.body)).toBe("var(--sp-5)");
    expect(task, "the task line has a rule of its own").toBeDefined();
    expect(inline(task.body)).toBe(inline(head.body));
  });

  it("follows the head on a narrow screen", () => {
    const narrow = of(".pb-sheet-task").filter((r) => r.body.includes("padding-left"));
    const head = of(".pb-sheet-head").filter((r) => r.body.includes("padding-left"));
    expect(narrow.map((r) => r.body.replace(/\s+/g, ""))).toEqual(head.map((r) => r.body.replace(/\s+/g, "")));
    expect(narrow.length).toBe(1);
  });
});

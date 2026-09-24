// What the composer must keep doing for card 378, read off disk.
//
// The walk itself is pinned through pure functions in composerKeys.test.ts.
// What that suite cannot see is the wiring: which module the key handler
// consults and in what order, that the counter row renders from the readout
// and from nothing else, and that the growth pass follows the value. Those
// live in JSX and in a dependency array, and this tree has no renderer, so
// they are guarded by reading the source.
//
// Every locator here throws when its anchor is missing rather than slicing on
// an indexOf that returned -1. String.slice reads -1 as one character from the
// end, so a guard built that way GROWS its window when the code moves and goes
// quiet instead of red.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { blockOf } from "../testkit/source";
import { dict } from "../i18n/i18n";

const chatRaw = read("./Chat.tsx", import.meta.url);
const chat = stripComments(chatRaw);
const keys = read("./composerKeys.ts", import.meta.url);
const composerCss = read("../styles/modal-composer.css", import.meta.url);

/**
 * The text between two anchors, or an error naming the one that moved.
 *
 * @param src the source to cut
 * @param from the opening anchor
 * @param to the closing anchor, searched for after the opening one
 */
function between(src: string, from: string, to: string): string {
  const open = src.indexOf(from);
  if (open < 0) throw new Error(`Chat.tsx no longer contains ${from}`);
  const close = src.indexOf(to, open + from.length);
  if (close < 0) throw new Error(`Chat.tsx no longer contains ${to} after ${from}`);
  return src.slice(open, close);
}

describe("the composer asks the key module, and asks it in the right order", () => {
  it("consults composerKeyAction inside onKeyDown", () => {
    const handler = between(chat, "onKeyDown={(e) => {", "onPaste=");
    expect(handler).toContain("composerKeyAction");
  });

  it("gives the slash picker first refusal, before the key module is asked", () => {
    // The picker owns both arrows while its list is open (SlashPicker.tsx).
    // Swapping these two lines takes the arrows away from the picker, and the
    // only thing that would notice is this assertion.
    const handler = between(chat, "onKeyDown={(e) => {", "onPaste=");
    const picker = handler.indexOf("slash.handleKey");
    const rule = handler.indexOf("composerKeyAction");
    expect(picker, "slash.handleKey is gone from the composer's key handler").toBeGreaterThanOrEqual(0);
    expect(rule, "composerKeyAction is gone from the composer's key handler").toBeGreaterThanOrEqual(0);
    expect(picker).toBeLessThan(rule);
  });

  it("imports the rule rather than restating it in the component", () => {
    expect(chat).toContain('from "./composerKeys"');
    // The old inline Enter rule moved into the module; a second copy in the
    // component would be a second answer to the same question.
    expect(chat).not.toContain('e.key === "Enter" && !e.shiftKey');
  });
});

describe("the counter row renders from the readout and from nothing else", () => {
  // The row ITSELF, not the whole stretch of file it sits in: a window wide
  // enough to swallow its neighbours would let one of them satisfy an
  // assertion about the row.
  const row = between(chat, '<div className="composer-history"', "</div>");

  it("draws the row from the pure readout's own fields", () => {
    expect(chat, "the readout is no longer computed by the pure function").toContain("recallReadout(walk)");
    expect(row).toContain("composer-history");
    expect(row).toContain("readout.position");
    expect(row).toContain("readout.total");
  });

  it("takes its words from the dictionary, not from a number glued to a string", () => {
    expect(row).toContain('t(lang, "composer.historyAt"');
    expect(row).toContain("n:");
    expect(row).toContain("total:");
    expect(row, "the row builds its text with a template literal").not.toContain("`");
    expect(row, "the row carries a hand-written separator").not.toContain('"/"');
  });

  it("carries both languages, with both placeholders in both", () => {
    const entry = dict["composer.historyAt"];
    expect(entry, "composer.historyAt is missing from the dictionary").toBeDefined();
    for (const lang of ["de", "en"] as const) {
      expect(entry[lang], `composer.historyAt.${lang}`).toContain("{n}");
      expect(entry[lang], `composer.historyAt.${lang}`).toContain("{total}");
    }
    expect(entry.de).toBe("Verlauf {n}/{total}");
    expect(entry.en).toBe("History {n}/{total}");
  });
});

describe("the counter row holds its line whether it has words or not", () => {
  // Audit 2026-09-21, section H point 4: the row used to be mounted only while
  // the walk stood on an entry, so the chat above moved by one line on the
  // first ArrowUp and again on the way home. A max-height would not help, it
  // is a lid: an empty row under a lid still collapses. What holds the line is
  // a slot that is always mounted AND a min-height that equals its line box.

  /** The declarations of one rule as a property map, last one winning. */
  function declarations(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of body.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
    return out;
  }

  it("mounts the slot at all times and puts the condition on the words inside it", () => {
    const open = chat.indexOf('<div className="composer-history"');
    if (open < 0) throw new Error('Chat.tsx no longer contains <div className="composer-history"');
    const before = chat.slice(0, open).trimEnd();
    expect(before, "the slot is mounted behind a condition again").not.toMatch(/(&&|\?|:)\s*\(?$/);
    const slot = between(chat, '<div className="composer-history"', "</div>");
    expect(slot, "the words no longer depend on the readout").toContain('readout.kind === "at"');
  });

  it("reserves the line with a min-height equal to the line box, not with a lid", () => {
    const rule = declarations(blockOf(composerCss, ".composer-history"));
    expect(rule["line-height"] ?? "(none)", "the row states no line-height in px").toMatch(/^\d+(\.\d+)?px$/);
    expect(rule["min-height"], "the row reserves no height").toBe(rule["line-height"]);
    expect(rule["white-space"], "a wrapped counter would outgrow its reservation").toBe("nowrap");
  });
});

describe("the height follows the value", () => {
  /** The dependency array of the one effect that calls the growth pass. */
  function autosizeDeps(src: string): string {
    const call = src.indexOf("autosize();");
    if (call < 0) throw new Error("Chat.tsx no longer calls autosize()");
    const open = src.indexOf("}, [", call);
    if (open < 0) throw new Error("the autosize() call is no longer inside an effect");
    const close = src.indexOf("]", open + 4);
    if (close < 0) throw new Error("the autosize() effect has no closing dependency array");
    return src.slice(open + 4, close);
  }

  it("names draft in the dependency array of the growth effect", () => {
    // Without this, a recall paints a ten-line prompt into a one-line box: the
    // recall sets the draft and nothing measures it. Card 374's reading of this
    // array was "voice.provisional, autosize", which is why the slash pick
    // never grew the box either.
    expect(autosizeDeps(chat)).toContain("draft");
  });

  it("keeps the growth pass in ONE place, so a keystroke pays the reflow once", () => {
    // autosize sets height to auto and then reads scrollHeight, which forces a
    // synchronous reflow. With draft in the dependency list, an inline call in
    // onChange makes every keystroke pay for that twice.
    expect(chat.split("autosize();").length - 1).toBe(1);
  });

  it("leaves the height alone in submit, so the effect is the only writer", () => {
    const submit = between(chat, "const submit = ()", "const lastUserText");
    expect(submit).not.toContain("style.height");
  });

  it("states the cap once, as an export the growth suite can import", () => {
    expect(chatRaw).toContain("export const TEXTAREA_MAX_HEIGHT_PX");
  });
});

describe("nothing new is painted", () => {
  it("keeps every colour out of the new module", () => {
    for (const bad of ["#", "rgb(", "hsl(", "color-mix("]) {
      expect(stripComments(keys), `composerKeys.ts carries ${bad}`).not.toContain(bad);
    }
  });

  it("paints the counter row in the faint ink the answer footers already use", () => {
    expect(blockOf(composerCss, ".composer-history")).toContain("var(--text-faint)");
  });

  it("leaves the one rule that caps the box alone", () => {
    // blockOf parses the selector instead of matching the compound class as a
    // substring, so ".composer-box textarea::placeholder" is a different
    // subject and cannot satisfy this. A grep for the class would take it.
    expect(blockOf(composerCss, ".composer-box textarea")).toContain("max-height: 240px");
  });
});

// Card 418: the wiring behind the open thinking body's ceiling, read off disk.
//
// thinkingCeiling.test.ts pins the rule (half the chat pane, never under
// 240 px) and the publishing. What it cannot see is whether anything reads
// the published value: that `.thinking-body` takes its max-height from it,
// that a thinking block outside the chat pane (a Spectrum lane) still gets
// the floor, that no other box moves with the pane, that the transcript
// scroller is the element that publishes, early enough for the first paint,
// and that the hook hands the effect's cleanup back to React. This tree has
// no renderer, so those are pinned in source.
//
// A percentage max-height would not do: the body sits inside the scrolling
// transcript, whose content has no definite height, so the pane measures
// itself and hands the number down as a custom property.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockOf, read, rules, stripComments } from "../testkit/source";
import { THINKING_BODY_MAX_VAR, THINKING_FLOOR_PX } from "../components/thinkingCeiling";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** @return every file under `dir`, recursively */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const allRules = walk(SRC)
  .filter((f) => f.endsWith(".css"))
  .flatMap((f) => rules(f.slice(SRC.length), readFileSync(f, "utf8")));

const chatCss = read("./chat.css", import.meta.url);
const chatTsx = stripComments(read("../components/Chat.tsx", import.meta.url));
const hookSrc = stripComments(read("../components/thinkingCeiling.ts", import.meta.url));

/**
 * The value of the LAST declaration of `prop` in a rule body, the one the
 * browser takes.
 *
 * @param body the declarations between a rule's braces
 * @param prop a property name, custom or not
 * @return the trimmed value, or undefined when the body does not declare it
 */
function lastValue(body: string, prop: string): string | undefined {
  const name = prop.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const found = [...body.matchAll(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, "g"))];
  return found.at(-1)?.[1].trim();
}

/**
 * The text from `from` to the next `to` after it, or an error naming the
 * anchor that moved.
 */
function between(src: string, from: string, to: string): string {
  const open = src.indexOf(from);
  if (open < 0) throw new Error(`the source no longer contains ${from}`);
  const close = src.indexOf(to, open + from.length);
  if (close < 0) throw new Error(`the source no longer contains ${to} after ${from}`);
  return src.slice(open, close);
}

describe("the open thinking body reads the ceiling the chat pane publishes", () => {
  it("takes its max-height from the published property instead of a fixed number", () => {
    expect(lastValue(blockOf(chatCss, ".thinking-body"), "max-height")).toBe(`var(${THINKING_BODY_MAX_VAR})`);
  });

  it("gets the floor wherever no chat pane publishes, declared once on :root", () => {
    const declared = allRules
      .filter((r) => lastValue(r.body, THINKING_BODY_MAX_VAR) !== undefined)
      .map((r) => `${r.rel} ${r.selector} ${lastValue(r.body, THINKING_BODY_MAX_VAR)}`);
    expect(declared).toEqual([`styles/chat.css :root ${THINKING_FLOOR_PX}px`]);
  });

  it("is read by .thinking-body alone, so no other box moves with the pane", () => {
    const readers = allRules
      .filter((r) => r.body.includes(`var(${THINKING_BODY_MAX_VAR}`))
      .map((r) => r.selector);
    expect(readers).toEqual([".thinking-body"]);
  });

  it("is published by the transcript scroller, the element that carries scrollRef", () => {
    expect(chatTsx).toMatch(/useThinkingCeiling\(scrollRef\);/);
    expect(chatTsx).toMatch(/className="chat-scroll"\s+ref=\{scrollRef\}/);
  });

  it("is published in a layout effect, so the first paint already has it", () => {
    const hook = between(hookSrc, "export function useThinkingCeiling", "\n}\n");
    expect(hook).toContain("useLayoutEffect(");
    expect(hook).not.toMatch(/\buseEffect\(/);
  });

  it("hands React the cleanup, so an unmounted chat stops observing", () => {
    // thinkingCeiling.test.ts proves startThinkingCeiling returns a cleanup that
    // disconnects the observer it built. Whether React ever gets that cleanup
    // is decided by this one line: an arrow with a block body would drop it
    // and every other test would stay green.
    const hook = between(hookSrc, "export function useThinkingCeiling", "\n}\n");
    expect(hook).toContain("useLayoutEffect(() => startThinkingCeiling(ref.current), [ref]);");
  });
});

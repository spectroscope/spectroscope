// Card 588, fix round: every command row's help wraps (M3), so moving the
// highlight moves no other row (M9). A list of wrapped rows can be taller than
// the popover, so a row the arrows reach is scrolled into view, the nearest
// way. A hover does not scroll: a row under a parked pointer would bounce the
// list (PlusMenuSettings.tsx measured that).
//
// The picker is hosted by HookHost so its effects run; the popover's ref gets
// a stand-in element that records the scrolls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { HookHost } from "../testkit/hookHost";
import { useSlashPicker, type SlashPicker } from "./SlashPicker";
import { __resetSkillList } from "../state/skillList";
import { __resetCommandList, __setCommandRows } from "../state/commandList";
import { coreCommandRows } from "../testkit/commandRows";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ skills: [] }),
    } as unknown as Response),
  );
  __setCommandRows(coreCommandRows());
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __resetCommandList();
});

type Props = { className?: unknown; ref?: unknown; onMouseEnter?: unknown; children?: ReactNode };

/** The host elements of a node, depth first, components left out. */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function") return [];
  return [node, ...elements(node.props.children)];
}

function classed(node: ReactNode, name: string): ReactElement<Props>[] {
  return elements(node).filter(
    (el) => typeof el.props.className === "string" && el.props.className.split(" ").includes(name),
  );
}

/** The picker over a draft, with a stand-in popover that records every scroll. */
function picker(draft: string) {
  const scrolls: unknown[] = [];
  const host = new HookHost<SlashPicker>(() =>
    useSlashPicker(
      draft,
      draft.length,
      true,
      () => {},
      () => {},
    ),
  );
  const pop = classed(host.value.node, "slash-pop")[0];
  expect(pop, "premise: the popover is open").toBeDefined();
  (pop.props.ref as { current: unknown }).current = {
    querySelector: (selector: string) =>
      selector === ".slash-row--on" ? { scrollIntoView: (how: unknown) => scrolls.push(how) } : null,
  };
  const press = (key: string): boolean =>
    host.value.handleKey({ key, preventDefault: () => {} } as unknown as KeyboardEvent);
  const hover = (at: number): void => {
    const row = classed(host.value.node, "slash-row")[at];
    (row.props.onMouseEnter as () => void)();
  };
  return { host, scrolls, press, hover };
}

describe("the highlighted row stays in view (card 588, fix round)", () => {
  it("scrolls the row the arrows reach into view, the nearest way", () => {
    const p = picker("/graph");
    expect(p.press("ArrowDown")).toBe(true);
    expect(p.scrolls).toEqual([{ block: "nearest" }]);
    p.press("ArrowUp");
    expect(p.scrolls).toEqual([{ block: "nearest" }, { block: "nearest" }]);
    p.host.unmount();
  });

  it("does not scroll for a hover, and scrolls again for the next arrow", () => {
    const p = picker("/graph");
    p.hover(3);
    expect(
      classed(p.host.value.node, "slash-row")[3]?.props.className,
      "premise: the hover moved the highlight",
    ).toContain("slash-row--on");
    expect(p.scrolls).toEqual([]);
    p.press("ArrowDown");
    expect(p.scrolls).toEqual([{ block: "nearest" }]);
    p.host.unmount();
  });
});

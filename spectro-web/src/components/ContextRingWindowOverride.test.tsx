// Card 390: the window the operator sets for this session, on the ring.
//
// The owner, 2026-09-23: "man oben in dem ring eine override einstellung hat,
// um das fenster fuer diese session zu overriden". The reverted first build put
// the input there and then read the wrong source word everywhere: the headline
// never divided by the window it set, the "on" label and the clear button keyed
// on the settings threshold (review 2026-09-24, E3 and E4), and the row showed
// in the replay view too, where "set" went to whatever socket was live (E8).
//
// No DOM in this suite (no jsdom), so the row is a hook-free component: the
// markup gives the visible half in both languages, and the element tree gives
// the wiring, because React elements are plain objects whose handlers can be
// called without a browser (the StoreRow.test.tsx recipe).

import { afterEach, describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPopover, ContextRing, WindowOverrideRow } from "./ContextRing";
import { contextGauge } from "./contextRingMath";
import type { ContextSnapshot } from "../state/reducer";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

afterEach(() => setLang("en"));

const snapshot = (extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  turn: 3,
  messages: 12,
  estimatedTokens: 8100,
  threshold: 143_001,
  thresholdSource: "window",
  contextWindow: 204_288,
  parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
  ...extra,
});

/** The frame the server answers a set of 512,000 with (and a run then carries). */
const SET = snapshot({ threshold: 358_400, thresholdSource: "window_override", contextWindow: 512_000 });

const popover = (
  context: ContextSnapshot | null,
  lastInputTokens: number,
  onWindowOverride: ((tokens: number | null) => void) | undefined,
): string => {
  const gauge = contextGauge(context?.threshold, context?.contextWindow, context?.thresholdSource);
  return renderToStaticMarkup(
    <ContextPopover
      lastInputTokens={lastInputTokens}
      context={context}
      gauge={gauge}
      shownPct={Math.round((lastInputTokens / gauge.denominator.value) * 100)}
      onWindowOverride={onWindowOverride}
    />,
  );
};

const headline = (html: string): string => {
  const m = /<p class="context-line tabular">(.*?)<\/p>/.exec(html);
  if (m === null) throw new Error(`no context line in: ${html}`);
  return m[1];
};

type Handlers = { onClick?: () => void; onKeyDown?: (e: { key: string }) => void; disabled?: boolean };

/** Every element of one tag in a tree, outermost first. */
function elements(node: ReactNode, tag: string): ReactElement<Handlers>[] {
  const found: ReactElement<Handlers>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function") {
      walk((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.type === tag) found.push(el as ReactElement<Handlers>);
    walk(el.props.children);
  };
  walk(node);
  return found;
}

/** The row as the popover builds it, and what its presses asked for. */
function row(draft: string, active: number | null, lang: Lang = "en") {
  const sets: number[] = [];
  let clears = 0;
  const element = (
    <WindowOverrideRow
      lang={lang}
      draft={draft}
      onDraft={() => {}}
      active={active}
      onSet={(n) => sets.push(n)}
      onClear={() => {
        clears += 1;
      }}
    />
  );
  const [set, clear] = elements(element, "button");
  const [input] = elements(element, "input");
  return { element, set, clear, input, sets, clears: () => clears };
}

describe("the ring divides by the window the operator set (card 390)", () => {
  it("names it as his and reads the share of it", () => {
    // 42,063 was the owner's input count on 2026-09-23 (S:91740); 42,063 of
    // 512,000 is 8.2 %. The reverted build would have divided by the 358,400
    // threshold and printed 12 % in the headline.
    expect(headline(popover(SET, 42_063, undefined))).toBe("42.1k of 512k set window (8%)");
  });

  it("keeps the compaction point as a number and as a mark", () => {
    expect(popover(SET, 42_063, undefined)).toContain("compacts at 358k");
    const ring = renderToStaticMarkup(
      <ContextRing lastInputTokens={42_063} context={SET} onWindowOverride={undefined} />,
    );
    expect(ring).toContain(">8%</span>");
    expect(ring).toContain('class="context-ring-mark"');
  });
});

describe("the popover row (card 390)", () => {
  it("is absent where nothing can receive it: the replay view", () => {
    const html = popover(SET, 42_063, undefined);
    expect(html).not.toContain("context-override");
    expect(html).not.toContain("Window for this session");
  });

  it("offers the input where a live session can receive it", () => {
    const html = popover(snapshot(), 42_063, () => {});
    expect(html).toContain('class="context-override"');
    expect(html).toContain("Window for this session");
    expect(html).toContain("8k to 10M");
    expect(html).not.toContain("Set for this session");
  });

  it("says the window is set for this session, in English", () => {
    const html = popover(SET, 42_063, () => {});
    expect(html).toContain("Set for this session: 512k");
  });

  it("says the window is set for this session, in German", () => {
    setLang("de");
    const html = popover(SET, 42_063, () => {});
    expect(html).toContain("Für diese Session gesetzt: 512k");
    expect(html).toContain("Fenster für diese Session");
    expect(html).not.toContain("Set for this session");
  });

  it("keys its on state on window_override and on nothing else", () => {
    // E4: the first build compared against "override", the settings threshold,
    // so a typed compactionThreshold looked like a window override and the
    // real one never did.
    const typed = snapshot({ threshold: 50_000, thresholdSource: "override", contextWindow: 1_000_000 });
    expect(popover(typed, 42_063, () => {})).not.toContain("Set for this session");
    expect(popover(SET, 42_063, () => {})).toContain("Set for this session");
  });
});

describe("the row's presses (card 390)", () => {
  it("set sends the whole number typed", () => {
    const r = row("512000", null);
    expect(r.set.props.disabled).toBe(false);
    r.set.props.onClick?.();
    expect(r.sets).toEqual([512_000]);
  });

  it("Enter in the input sends it too", () => {
    const r = row("250368", null);
    r.input.props.onKeyDown?.({ key: "Enter" });
    expect(r.sets).toEqual([250_368]);
  });

  it("set is off and sends nothing for a draft the server would refuse", () => {
    for (const draft of ["", "7999", "0.4", "512k", "10000001"]) {
      const r = row(draft, null);
      expect(r.set.props.disabled, draft).toBe(true);
      r.set.props.onClick?.();
      r.input.props.onKeyDown?.({ key: "Enter" });
      expect(r.sets, draft).toEqual([]);
    }
  });

  it("clear is on only while a window is set, and sends the clear", () => {
    const off = row("", null);
    expect(off.clear.props.disabled).toBe(true);

    const on = row("", 512_000);
    expect(on.clear.props.disabled).toBe(false);
    on.clear.props.onClick?.();
    expect(on.clears()).toBe(1);
    expect(on.sets).toEqual([]);
  });
});

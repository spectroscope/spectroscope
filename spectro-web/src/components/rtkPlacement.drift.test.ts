// Card 379, fix round 2026-09-24: where the rtk switch sits, read off disk.
//
// The owner's words (2026-09-21): "bitte baue die native nutzung von RTK als
// option unten in den chat einstellungen ein". The chat settings are the
// composer's settings menu, and "unten" puts the option at the bottom of it:
// the last section. It is not a control of its own in the icon row under the
// field. Card 383 counts that row, and the audit of 2026-09-21 decided that a
// red count there is answered by moving the control, never by raising the
// number.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const menu = stripComments(read("./DisclosureMenu.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));

/**
 * The popover's sections in render order, each named by the first dictionary
 * key it prints. A mounted `<RtkFilterSection>` counts as the section it
 * renders, so the order holds whether the rtk section is written inline or
 * drawn by its own component.
 *
 * @param src DisclosureMenu.tsx without comments
 * @returns the section names, top to bottom
 */
function sectionOrder(src: string): string[] {
  const marks: { at: number; name: string }[] = [];
  for (const m of src.matchAll(/className="wsg-section[ "]/g)) {
    const head = /t\(lang, "([^"]+)"/.exec(src.slice(m.index));
    marks.push({ at: m.index, name: head?.[1] ?? "?" });
  }
  for (const m of src.matchAll(/<RtkFilterSection\b/g)) {
    marks.push({ at: m.index, name: "rtk.title" });
  }
  return marks.sort((a, b) => a.at - b.at).map((m) => m.name);
}

describe("the rtk switch in the chat settings", () => {
  it("is the last section of the menu, at the bottom where the owner asked for it", () => {
    const order = sectionOrder(menu);
    expect(order.length, "the menu has sections to order").toBeGreaterThan(1);
    expect(order.at(-1), `sections top to bottom: ${order.join(", ")}`).toBe("rtk.title");
  });

  it("appears exactly once, so the last section is the only rtk section", () => {
    expect(sectionOrder(menu).filter((name) => name === "rtk.title")).toHaveLength(1);
  });

  it("adds nothing to the icon row under the field", () => {
    // The positive half first: the menu mounts it, so the absence below is a
    // placement and not a feature that went missing.
    expect(menu).toContain("<RtkFilterSection");
    expect(chat).toContain("<DisclosureMenu");
    expect(chat).not.toContain("RtkFilterSection");
    expect(chat).not.toContain("rtkFilter");
  });
});

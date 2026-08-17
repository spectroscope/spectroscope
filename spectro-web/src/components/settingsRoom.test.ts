// Card 256, the regression an adversarial verifier found after the build: the
// room a reader picked by hand OUTLIVED the visit it was picked in, and the next
// deep link to the same section lost against it.
//
// It looked safe because the pick was stamped with the address it was made
// under. The flaw is that the address REPEATS: `open:mcp` is the same string
// every single time that one deep link opens the panel, so a pick from the
// previous visit matched again and won. The reader landed in the wrong room —
// and the scroll went silent too, because `scrollIntoView` on an anchor inside a
// `display:none` page does nothing while cheerfully marking itself done.
//
// The whole position is therefore folded here, away from React: a run of the
// panel is a sequence of ADDRESS events (what the panel is asked to show) and
// PICK events (what the reader clicked), and every frame of it can be asserted.
// Each address event is checked twice — the room the first paint shows, and the
// room that stands after the panel reconciles — because a fix that only settles
// one frame later still flashes the wrong room, and one frame is all the scroll
// effect needs to look into a hidden page.

import { describe, expect, it } from "vitest";
import {
  SETTINGS_ROOM_START,
  settingsAddress,
  settingsRoomAt,
  settingsRoomPick,
  settingsRoomShown,
  settingsScrollTarget,
  type SettingsRoomState,
} from "./settingsRoom";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  RELOCATED_SECTIONS,
  settingsTabFor,
  type SettingsTab,
} from "./settingsTabs";
import { SETTINGS_SECTIONS, type SettingsSection } from "../state/route";
import { read, stripComments } from "../testkit/source";

/** What the panel is asked to show, or what the reader clicked. */
type Step =
  | { readonly at: { readonly open: boolean; readonly section: SettingsSection | null } }
  | { readonly pick: SettingsTab };

/** One frame of the run: the room the paint shows, the room left standing
 *  afterwards, and the section the deep-link scroll may consume. */
type Frame = {
  readonly paint: SettingsTab;
  readonly settled: SettingsTab;
  readonly scroll: SettingsSection | null;
};

/**
 * The panel without React, in the panel's own order: the render derives the room
 * from (remembered pick, address) FIRST, and the reconciling effect steps the
 * remembered pick afterwards.
 */
function run(steps: readonly Step[]): readonly Frame[] {
  let state: SettingsRoomState = SETTINGS_ROOM_START;
  let open = false;
  let section: SettingsSection | null = null;
  const frames: Frame[] = [];
  for (const step of steps) {
    if ("pick" in step) {
      state = settingsRoomPick(settingsAddress(open, section), step.pick);
      const room = settingsRoomShown(state, settingsAddress(open, section), section);
      frames.push({ paint: room, settled: room, scroll: settingsScrollTarget(room, section) });
      continue;
    }
    open = step.at.open;
    section = step.at.section;
    const address = settingsAddress(open, section);
    // The paint happens before any effect: whatever the panel still remembers
    // meets the NEW address here.
    const paint = settingsRoomShown(state, address, section);
    state = settingsRoomAt(state, address);
    const settled = settingsRoomShown(state, address, section);
    frames.push({ paint, settled, scroll: settingsScrollTarget(settled, section) });
  }
  return frames;
}

const last = (frames: readonly Frame[]): Frame => frames[frames.length - 1] as Frame;

describe("a deep link outranks the room the reader wandered into", () => {
  it("lands in the named room when the SAME deep link opens a second time", () => {
    // The regression, in the order it happens: the plus menu's Manage row opens
    // the MCP section, the reader looks at another room, closes, and takes the
    // same row again. The address of the second visit is character for character
    // the address of the first, so a pick stamped with it matched and won.
    const frames = run([
      { at: { open: true, section: "mcp" } },
      { pick: "general" },
      { at: { open: false, section: null } },
      { at: { open: true, section: "mcp" } },
    ]);
    expect(last(frames).settled, "the remembered room outranked the deep link").toBe("mcp");
    // And not one frame late either: a paint in the wrong room is where the
    // scroll effect finds the anchor hidden and burns its one chance.
    expect(last(frames).paint, "the first paint stood in the wrong room").toBe("mcp");
    expect(last(frames).scroll, "the scroll was skipped for a room that is not shown").toBe("mcp");
  });

  it("holds for every section, from every room the reader may have wandered into", () => {
    for (const section of SETTINGS_SECTIONS) {
      const home = settingsTabFor(section);
      for (const wandered of SETTINGS_TABS) {
        const frames = run([
          { at: { open: true, section } },
          { pick: wandered },
          { at: { open: false, section: null } },
          { at: { open: true, section } },
        ]);
        expect(last(frames).settled, `${section} reopened into ${wandered}`).toBe(home);
        expect(last(frames).paint, `${section} painted ${wandered} first`).toBe(home);
      }
    }
  });

  it("also outranks the pick when a NEW section is named while the panel stays open", () => {
    // The onboarding sheet's row and a back-press onto another settings entry
    // both do this without a close in between.
    const frames = run([
      { at: { open: true, section: "mcp" } },
      { pick: "general" },
      { at: { open: true, section: "session" } },
    ]);
    expect(last(frames).paint).toBe("models");
    expect(last(frames).settled).toBe("models");
    expect(last(frames).scroll).toBe("session");
  });

  it("forgets the room on the way out, so a plain open lands where a plain open lands", () => {
    const frames = run([
      { at: { open: true, section: null } },
      { pick: "permissions" },
      { at: { open: false, section: null } },
      { at: { open: true, section: null } },
    ]);
    expect(last(frames).settled).toBe(DEFAULT_SETTINGS_TAB);
    expect(last(frames).scroll).toBeNull();
  });
});

describe("the room the reader picks still stands while he is in it", () => {
  it("keeps the picked room across re-renders of the same address", () => {
    // The other half of the fence: the fix may not make the tab row unclickable
    // on a deep-linked open. React re-renders this panel on every unrelated
    // prop change, and each one arrives as the same address.
    const frames = run([
      { at: { open: true, section: "mcp" } },
      { pick: "general" },
      { at: { open: true, section: "mcp" } },
      { at: { open: true, section: "mcp" } },
    ]);
    expect(last(frames).settled).toBe("general");
    expect(last(frames).paint).toBe("general");
  });

  it("keeps a plain open's picked room across re-renders", () => {
    const frames = run([
      { at: { open: true, section: null } },
      { pick: "system" },
      { at: { open: true, section: null } },
    ]);
    expect(last(frames).settled).toBe("system");
  });

  it("stands still when the address has not moved, object identity included", () => {
    // The render consults this reducer through an effect; a step that returned a
    // fresh object for an unchanged address would set state on every render.
    const state = settingsRoomPick(settingsAddress(true, "mcp"), "general");
    expect(settingsRoomAt(state, settingsAddress(true, "mcp"))).toBe(state);
  });
});

describe("the scroll is only ever marked done for a room that is shown", () => {
  it("offers the section when its room is the one on screen", () => {
    for (const section of SETTINGS_SECTIONS) {
      const room = settingsTabFor(section);
      const relocated = (RELOCATED_SECTIONS as readonly string[]).includes(section);
      // A relocated section has no anchor on this page at all (card 228 moved
      // the skills manager to the rail), so there is nothing to scroll to.
      expect(settingsScrollTarget(room, section)).toBe(relocated ? null : section);
    }
  });

  it("offers nothing while another room is shown", () => {
    // This is the silent half of the defect: the anchor EXISTS in the DOM
    // (inactive pages are hidden, not unmounted), so the old code found it,
    // scrolled nothing, and marked the section done for good.
    for (const section of SETTINGS_SECTIONS) {
      for (const room of SETTINGS_TABS) {
        if (room === settingsTabFor(section)) continue;
        expect(settingsScrollTarget(room, section), `${section} was consumed from ${room}`).toBeNull();
      }
    }
  });

  it("offers nothing for a plain open", () => {
    for (const room of SETTINGS_TABS) {
      expect(settingsScrollTarget(room, null)).toBeNull();
      expect(settingsScrollTarget(room, undefined)).toBeNull();
    }
  });

  it("withholds the scroll while the reader stands in another room", () => {
    const frames = run([{ at: { open: true, section: "mcp" } }, { pick: "general" }]);
    expect(frames[0]?.scroll).toBe("mcp");
    expect(last(frames).scroll, "the deep link was consumed from the wrong room").toBeNull();
  });
});

describe("the address is spelled in one place", () => {
  it("separates open from closed, and one section from another", () => {
    expect(settingsAddress(true, "mcp")).not.toBe(settingsAddress(false, "mcp"));
    expect(settingsAddress(true, "mcp")).not.toBe(settingsAddress(true, "session"));
    expect(settingsAddress(true, null)).not.toBe(settingsAddress(true, "mcp"));
    expect(settingsAddress(true, null)).toBe(settingsAddress(true, undefined));
    const all = SETTINGS_SECTIONS.map((s) => settingsAddress(true, s));
    expect(new Set(all).size).toBe(all.length);
  });

  it("starts closed and unpicked", () => {
    expect(SETTINGS_ROOM_START.picked).toBeNull();
    expect(settingsRoomShown(SETTINGS_ROOM_START, settingsAddress(true, "mcp"), "mcp")).toBe("mcp");
  });
});

describe("the consumer — the panel reads its position from this fold", () => {
  const panel = stripComments(read("./SettingsPanel.tsx", import.meta.url));

  it("derives the room through the fold instead of spelling the address itself", () => {
    expect(panel).toContain("settingsAddress(");
    expect(panel).toContain("settingsRoomShown(");
    expect(panel).toContain("settingsRoomAt(");
    expect(panel).toContain("settingsRoomPick(");
    // The template that repeated across visits. Written out here so the defect
    // cannot come back by being retyped in the panel.
    expect(panel).not.toContain('? "open" : "closed"');
  });

  it("marks the scroll done only for the section the fold handed it", () => {
    // Not `section`: that is the request, and the request stays true while the
    // reader stands somewhere else. `scrollTo` is null in exactly that case, so
    // the anchor is neither sought nor consumed.
    expect(panel).toContain("settingsScrollTarget(");
    expect(panel).toContain("document.getElementById(sectionAnchorId(scrollTo))");
    expect(panel).toContain("scrolledFor.current = scrollTo");
    expect(panel).not.toContain("scrolledFor.current = section");
  });
});

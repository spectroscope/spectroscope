// Card 430, criterion 2, the two controls the table closes outside the tab
// row and the rail: the live trace switch in the chat's menu and the fleet
// section of the settings page. Both belong to surfaces light closes, the
// trace and the fleets, so light does not draw them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { settingsSectionOpen } from "../state/surfaces";
import { __resetViewModeForTests, __setViewModeStorage, setViewMode } from "../state/viewMode";
import { drive, type El } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { DisclosureMenu } from "./DisclosureMenu";

beforeEach(() => {
  const store = new Map<string, string>();
  __setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
  __resetViewModeForTests();
});
afterEach(() => setViewMode("learn"));

/** The text an element holds, children flattened. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    return textOf((node as El).props.children);
  }
  return "";
}

/** The menu opened by its own button, as the next pass draws it. */
function openedMenu(): El[] {
  return drive(
    <DisclosureMenu />,
    [DisclosureMenu],
    [(tree) => tree.find((el) => el.props["aria-haspopup"] === "menu")?.props.onClick?.()],
  );
}

const liveTraceRows = (tree: El[]): El[] =>
  tree.filter(
    (el) =>
      el.props.role === "menuitemcheckbox" &&
      [dict["trace.live.on"].en, dict["trace.live.off"].en].some((word) => textOf(el).includes(word)),
  );

describe("the live trace switch in the chat's menu", () => {
  it("is drawn in learn", () => {
    expect(liveTraceRows(openedMenu())).toHaveLength(1);
  });

  it("is not drawn in light, where the trace is closed", () => {
    setViewMode("light");
    const tree = openedMenu();
    expect(liveTraceRows(tree)).toHaveLength(0);
    // The menu itself opened: its other rows are there.
    expect(tree.some((el) => el.props.role === "menuitemradio")).toBe(true);
  });
});

describe("the fleet section of the settings page", () => {
  it("is open in learn and closed in light; every other section stays", () => {
    expect(settingsSectionOpen("fleet", "learn")).toBe(true);
    expect(settingsSectionOpen("fleet", "light")).toBe(false);
    for (const section of ["design", "session", "observability", "leveling", "limits"]) {
      expect(settingsSectionOpen(section, "light"), section).toBe(true);
    }
  });

  it("is mounted and searched only where it is open", () => {
    const panel = stripComments(read("./SettingsPanel.tsx", import.meta.url));
    expect(panel).toMatch(
      /\{settingsSectionOpen\("fleet", viewMode\) && \(\s*<FleetSettings anchorId=\{sectionAnchorId\("fleet"\)\} \/>\s*\)\}/,
    );
    expect(panel.split("<FleetSettings").length - 1).toBe(1);
    expect(panel).toMatch(
      /buildSettingsManifest\(lang, registry\)\.filter\(\(hit\) =>\s*settingsSectionOpen\(hit\.section, viewMode\),?\s*\)/,
    );
  });
});

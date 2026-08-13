// The cross-project pins for the desktop menus.
//
// menuModel.test.ts proves the menu's shape is sane on its own terms. These
// cases prove it still points at things that exist HERE — sections the router
// parses, demo artifacts the state graph bundles, the repository the About
// panel names. Two projects, two build systems, nothing else connecting them:
// exactly the wire that dies quietly, which is what a drift test is for.

import { describe, expect, it } from "vitest";
import { appMenuModel, REPO, type MenuNode } from "../../../spectro-desktop/src/menuModel";
import { SETTINGS_SECTIONS, parseAppRoute } from "./route";
import { SCENARIOS } from "../stategraph/StateGraphPane";
import { ABOUT } from "../components/about";

const MAC = appMenuModel({ productName: "spectroscope", isMac: true });

function walk(nodes: readonly MenuNode[]): MenuNode[] {
  return nodes.flatMap((n) => (n.kind === "submenu" ? [n, ...walk(n.items)] : [n]));
}

function submenu(label: string): MenuNode[] {
  const found = walk(MAC).find((n) => n.kind === "submenu" && n.label === label);
  if (!found || found.kind !== "submenu") throw new Error(`no submenu named ${label}`);
  return [...found.items];
}

describe("what the desktop menus point at", () => {
  it("offers every settings section the router knows", () => {
    const hashes = submenu("Settings").flatMap((n) =>
      n.kind === "hash" && n.hash.startsWith("#/settings/") ? [n.hash] : [],
    );
    // Adding a section to route.ts without adding it to the menu turns this
    // red — which is how "Skills" gets its menu row the day it becomes one.
    expect(hashes).toEqual(SETTINGS_SECTIONS.map((s) => `#/settings/${s}`));
  });

  it("names demos the state graph actually bundles", () => {
    const demos = submenu("Load a demo").flatMap((n) =>
      n.kind === "command" && n.command === "stategraph.demo" ? [n] : [],
    );
    expect(demos.map((n) => n.arg)).toEqual(SCENARIOS.map((s) => s.source));
    // A renamed artifact must not leave a menu row that loads nothing, and a
    // retitled scenario must not leave the menu calling it something else.
    expect(demos.map((n) => n.label)).toEqual(SCENARIOS.map((s) => s.title.en));
  });

  it("navigates only to addresses the router parses", () => {
    const hashes = walk(MAC).flatMap((n) => (n.kind === "hash" ? [n.hash] : []));
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      const route = parseAppRoute(hash);
      // route.ts answers anything it does not know with the live default, so
      // an address that names nothing real lands the reader somewhere else
      // entirely and says nothing about it.
      expect({ hash, kind: route.kind }).toEqual({ hash, kind: "settings" });
    }
  });

  it("links only the repository the About panel names", () => {
    // ABOUT.repo is itself pinned to LICENSE-ASSETS.md by about.drift.test.ts,
    // so this hangs the shell's copy of the URL off that same nail.
    expect(REPO).toBe(ABOUT.repo);
    const urls = walk(MAC).flatMap((n) => (n.kind === "url" ? [n.url] : []));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(ABOUT.repo)).toBe(true);
  });
});

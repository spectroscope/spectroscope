// Card 387: one list of modes, and every piece of tutorial chrome behind a
// guard that names the mode.
//
// Two separate defects live here, and both are of the family the canon calls a
// hand list guarded by a test that types the same hand list. First, the triple
// "ladder" | "checklist" | "off" was typed in three files that cannot see each
// other, so a fourth mode would have needed four edits and nothing would have
// noticed a missed one. Second, two render sites of tutorial chrome carried no
// mode guard at all and were invisible in `off` only because other guards
// happened to hold.
//
// So nothing below is typed twice. The mode list is read from the Java enum
// that serves it, the files carrying tutorial chrome are read off disk, and
// each render site's guard is found by walking up from the site rather than by
// quoting a line number that moves.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";
import { LEVELING_MODES } from "../state/leveling";

const SRC = fileURLToPath(new URL("..", import.meta.url));

const LEVELING_STATE =
  "../../../spectro-core/src/main/java/dev/spectroscope/core/leveling/LevelingState.java";

/** Any class name of the tutorial, in a string or a template. */
const LVL_CLASS = /["`]lvl-/;

/** The shipped tree, comments blanked: prose about a mode is not a mode. */
const shipped = new Map<string, string>(
  srcFiles(SRC)
    .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
    .map((file) => [file.slice(SRC.length), stripComments(srcText(file))]),
);

const app = (shipped.get("App.tsx") ?? "").split("\n");
const settings = shipped.get("components/SettingsPanel.tsx") ?? "";

/** How far a line is indented, which is what tells an outer guard from an inner one. */
const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Every JSX condition the line at `at` sits inside, innermost first.
 *
 * Walks up, and takes a conditional opener (`… && (` or `… ? (`) only when it
 * is indented LESS than the last one taken. Without that, a site nested in an
 * inner condition reports only the inner one: the level-up toast's own text
 * sits under `levelUp.opened.length > 0`, and a test reading the nearest line
 * would have said the toast carried no mode guard while it did.
 */
function guardsAround(at: number): string[] {
  const chain: string[] = [];
  let depth = indentOf(app[at]);
  for (let above = at - 1; above >= 0; above--) {
    const line = app[above];
    if (!/(?:&&|\?)\s*\($/.test(line.trim())) continue;
    if (indentOf(line) >= depth) continue;
    chain.push(line.trim());
    depth = indentOf(line);
  }
  return chain;
}

/** Every line of App.tsx that mounts or draws `needle`, by index. */
function sitesOf(needle: string | RegExp): number[] {
  const hit =
    typeof needle === "string"
      ? (line: string) => line.includes(needle)
      : (line: string) => needle.test(line);
  return app.map((line, index) => (hit(line) ? index : -1)).filter((index) => index >= 0);
}

const MODE_GUARD = /leveling\.snapshot\.mode !== "off"/;

/**
 * Every file that draws tutorial chrome, and the guard that may hide it.
 *
 * `null` marks the one exemption, stated with its reason: the leveling section
 * of the settings renders in every mode on purpose, because it is the way back
 * from `off`. Its own reset button borrows an `lvl-` class, which is why the
 * file appears here at all.
 */
const CHROME: Record<string, { site: string | RegExp; guard: RegExp } | null> = {
  "App.tsx": { site: LVL_CLASS, guard: MODE_GUARD },
  "components/LevelPill.tsx": { site: "<LevelPill", guard: MODE_GUARD },
  "components/LevelingPanel.tsx": { site: "<LevelingPanel", guard: MODE_GUARD },
  "components/LevelingIntro.tsx": { site: "<LevelingIntro", guard: /!leveling\.snapshot\.introSeen/ },
  "components/LockedSurface.tsx": {
    site: "<LockedSurface",
    guard: /!isSurfaceOpen\(leveling\.snapshot, tab\)/,
  },
  "components/SettingsPanel.tsx": null,
};

describe("the mode list", () => {
  it("is the list the server enum declares, in the same order", () => {
    const body = /enum Mode \{([\s\S]*?)\n {4}\}/.exec(read(LEVELING_STATE, import.meta.url));
    expect(body, "LevelingState.Mode is gone").not.toBeNull();
    const members = [...body![1].matchAll(/^\s{8}([A-Z]+)[,;]/gm)].map((match) => match[1].toLowerCase());
    expect(members.length, "the enum reads as empty, so the regex has drifted").toBeGreaterThan(0);
    expect([...LEVELING_MODES]).toEqual(members);
  });

  it("is typed exactly once in the shipped web tree", () => {
    const typed = [...shipped]
      .filter(([, src]) => src.includes('"ladder" | "checklist"'))
      .map(([file]) => file);
    expect(typed).toEqual(["state/leveling.ts"]);
  });

  it("is what the welcome screen offers, rather than a subset it types", () => {
    const intro = shipped.get("components/LevelingIntro.tsx") ?? "";
    expect(intro, "the welcome screen stopped reading the list").toContain("LEVELING_MODES");
    for (const mode of LEVELING_MODES) {
      expect(intro, `LevelingIntro names "${mode}" itself again`).not.toContain(`"${mode}"`);
    }
  });

  it("is what the settings select offers, rather than a second hand copy", () => {
    // Scoped to the one select this card is about. The settings page holds
    // other selects with an "off" option (the thinking toggle), and a file-wide
    // search would call that one a leveling mode.
    const open = settings.indexOf("value={leveling.snapshot.mode}");
    expect(open, "the settings no longer bind a select to the mode").toBeGreaterThan(-1);
    const close = settings.indexOf("</select>", open);
    expect(close, "that select never closes").toBeGreaterThan(open);
    const select = settings.slice(open, close);
    expect(select, "the select stopped reading the list").toContain("LEVELING_MODES");
    expect(select, "the select types an option value by hand again").not.toMatch(/value="/);
  });
});

describe("tutorial chrome", () => {
  it("is drawn from exactly the files this test knows about", () => {
    const drawing = [...shipped]
      .filter(([, src]) => LVL_CLASS.test(src))
      .map(([file]) => file)
      .sort();
    expect(drawing).toEqual(Object.keys(CHROME).sort());
  });

  it("renders every site behind the guard that covers it", () => {
    for (const [file, cover] of Object.entries(CHROME)) {
      if (cover === null) continue;
      const sites = sitesOf(cover.site);
      expect(sites.length, `${file}: App.tsx no longer renders ${String(cover.site)}`).toBeGreaterThan(0);
      for (const at of sites) {
        const chain = guardsAround(at);
        expect(
          chain.some((guard) => cover.guard.test(guard)),
          `${file}: line ${at + 1} renders under ${JSON.stringify(chain)}, none of which is ${cover.guard}`,
        ).toBe(true);
      }
    }
  });

  it("covers the dock with the drawer exactly while the drawer is drawn", () => {
    // The dock hides its native browser pane while dockCovered is true. The
    // drawer hides itself in off, so a bare levelPanelOpen there kept the pane
    // hidden after off was chosen in the settings with the drawer still open.
    // The term is read from the drawer's own guard, not typed here.
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    const scrim = sitesOf('"lvl-drawer-scrim"');
    expect(scrim.length, "App.tsx no longer draws the drawer scrim once").toBe(1);
    const drawn = flat(
      guardsAround(scrim[0])[0]
        .replace(/^\{/, "")
        .replace(/&&\s*\($/, ""),
    );
    expect(drawn, "the drawer lost its mode guard").toMatch(MODE_GUARD);
    const source = app.join("\n");
    const start = source.indexOf("const dockCovered");
    expect(start, "dockCovered is gone").toBeGreaterThan(-1);
    const decl = source.slice(source.indexOf("=", start) + 1, source.indexOf(";", start));
    const terms = decl.split("||").map((term) => flat(term).replace(/^\((.*)\)$/, "$1"));
    expect(terms).toContain(drawn);
    expect(terms).not.toContain("levelPanelOpen");
  });

  it("exempts the settings section by name, because it is the way back", () => {
    expect(settings).toContain('sectionAnchorId("leveling")');
    expect(settings).toContain("lvl-open-all");
  });
});

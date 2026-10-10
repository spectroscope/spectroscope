// Card 381, the search half: one box above the rooms, and a manifest that is
// derived from three sources rather than typed.
//
// There is no DOM in this suite (house rule), so the page is server-rendered
// and the markup is walked with an ancestor-aware scanner written below and
// proved against a fixture before it is believed. A bare count of search
// inputs would be the wrong assertion anyway: the rooms stay MOUNTED and
// hidden (`hidden={tab !== active}`, SettingsPanel.tsx), so an input inside a
// room is in the document whichever room is on screen.

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSearch } from "./SettingsSearchBox";
import { SettingsPanel, sectionAnchorId } from "./SettingsPanel";
import { SETTINGS_TABS, SETTINGS_TAB_SECTIONS, sectionsOfTab, type SettingsTab } from "./settingsTabs";
import { SETTING_REACH } from "./settingsReach";
import {
  OFF_PAGE_NO_REACH_KEYS,
  OFF_PAGE_SETTING_KEYS,
  SECTION_SETTING_KEYS,
  SETTINGS_HIT_ORIGINS,
  settingsHitKindKey,
  SETTINGS_SECTION_LABEL_KEY,
  buildSettingsManifest,
  matchSettings,
  openSettingsHit,
  scrollToSettingsAnchor,
  settingsHitAnchorId,
  settingsSearchHaystack,
  type SettingsHit,
} from "./settingsSearch";
import { dict } from "../i18n/i18n";
import type { GoverningNumber } from "../state/governingNumbers";
import { read, stripComments } from "../testkit/source";

const REGISTRY = "../../../spectro-core/src/main/resources/governing/numbers.json";
const registry: GoverningNumber[] = JSON.parse(read(REGISTRY, import.meta.url)) as GoverningNumber[];

const manifest = buildSettingsManifest("en", registry);

// ---- the ancestor-aware scanner, and its own proof -------------------------

/** Every `<input type="search">` in a markup string, with how many of its
 *  ancestors carry the `hidden` attribute. Tag-level walk: the markup comes
 *  from renderToStaticMarkup, so it is well formed and every element either
 *  self-closes or closes by name. */
function searchInputs(html: string): { hiddenAncestors: number }[] {
  const VOID = new Set(["input", "br", "hr", "img", "meta", "link", "path", "source", "use", "circle"]);
  const open: boolean[] = [];
  const found: { hiddenAncestors: number }[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^">])*)(\/?)>/g)) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    const selfClosing = m[4] === "/";
    if (closing) {
      open.pop();
      continue;
    }
    const isHidden = /\bhidden(?:=|\s|$)/.test(attrs);
    if (name === "input" && /\btype="search"/.test(attrs)) {
      found.push({ hiddenAncestors: open.filter(Boolean).length });
    }
    if (!VOID.has(name) && !selfClosing) open.push(isHidden);
  }
  return found;
}

describe("the scanner this file believes", () => {
  it("sees a hidden ancestor when there is one, and none when there is not", () => {
    // The positive control. Without it the assertion further down is a
    // negation standing on its own, which is the shape that waves an empty
    // page through.
    const buried = '<div><div hidden><label><input type="search"/></label></div></div>';
    const plain = '<div><label><input type="search"/></label></div>';
    expect(searchInputs(buried)).toEqual([{ hiddenAncestors: 1 }]);
    expect(searchInputs(plain)).toEqual([{ hiddenAncestors: 0 }]);
    expect(searchInputs('<div><input type="text"/></div>')).toEqual([]);
  });
});

// ---- criterion 1 -----------------------------------------------------------

function panelMarkup(section: Parameters<typeof SettingsPanel>[0]["section"]): string {
  return renderToStaticMarkup(<SettingsPanel open onClose={() => {}} section={section} session={null} />);
}

describe("one search field, page wide, outside every room", () => {
  it("draws exactly one search input and it stands under no hidden ancestor", () => {
    for (const tab of SETTINGS_TABS) {
      // The deep link decides which room is active, which is the only lever a
      // server render has over the panel's room.
      const first = sectionsOfTab(tab)[0];
      const inputs = searchInputs(panelMarkup(first));
      expect(inputs.length, `room ${tab} draws ${inputs.length} search inputs`).toBe(1);
      expect(inputs[0].hiddenAncestors, `room ${tab}: the box sits inside a hidden room`).toBe(0);
    }
  });

  it("leaves no second box inside the limits room", () => {
    // The limits block only draws once its fetch has answered, and an effect
    // does not run in a server render, so the room's markup cannot carry the
    // proof. Its source can: the box moved up a level and did not get copied.
    const block = stripComments(read("./GoverningNumbersBlock.tsx", import.meta.url));
    expect(block, "the limits room still draws a search box of its own").not.toContain('type="search"');
  });
});

// ---- criterion 2 -----------------------------------------------------------

describe("the manifest is derived, never typed", () => {
  it("carries every section of the grouping table", () => {
    for (const tab of SETTINGS_TABS) {
      for (const section of sectionsOfTab(tab)) {
        const hit = manifest.find((h) => h.origin === "section" && h.section === section);
        expect(hit, `section ${section} is missing from the manifest`).toBeDefined();
        expect((hit as { tab: SettingsTab }).tab, `${section} is filed under the wrong room`).toBe(tab);
      }
    }
  });

  it("carries every reach key the page draws, and no field for a key drawn elsewhere", () => {
    // A field hit opens a room and scrolls to a section. A key whose control
    // stands outside the page has neither, so a hit for it would send the
    // reader to a section without the control.
    const elsewhere = new Set<string>([
      ...Object.keys(OFF_PAGE_SETTING_KEYS),
      ...Object.keys(OFF_PAGE_NO_REACH_KEYS),
    ]);
    for (const key of Object.keys(SETTING_REACH)) {
      const found = manifest.some((h) => h.origin === "field" && h.key === key);
      if (elsewhere.has(key)) {
        expect(found, `${key} is drawn outside the settings page and still has a field hit`).toBe(false);
      } else {
        expect(found, `reach key ${key} is missing from the manifest`).toBe(true);
      }
    }
  });

  it("carries every row of the generated registry", () => {
    expect(registry.length).toBeGreaterThan(0);
    for (const number of registry) {
      expect(
        manifest.some((h) => h.origin === "number" && h.id === `number:${number.owner}#${number.field}`),
        `${number.owner}.${number.field} is missing from the manifest`,
      ).toBe(true);
    }
  });

  it("places every reach key in exactly one section or names where else it is drawn, and every section it names is a real one", () => {
    // This is what keeps the placement table honest: it is authored, and its
    // COVERAGE is demanded from a different source. A thirty-seventh reach key
    // that nobody placed turns this red before the search can quietly drop it.
    // Since card 379 a key may instead stand in the off-page table. The two
    // together still have to equal the reach table, and a key in both is
    // counted twice, which fails. Since card 493 a key may stand in a third
    // table, for a control outside the page that draws no reach block, or
    // for a key no control sets.
    const placed = Object.values(SECTION_SETTING_KEYS).flat();
    const elsewhere = [...Object.keys(OFF_PAGE_SETTING_KEYS), ...Object.keys(OFF_PAGE_NO_REACH_KEYS)];
    expect([...placed, ...elsewhere].sort()).toEqual(Object.keys(SETTING_REACH).sort());
    const sections = new Set(Object.values(SETTINGS_TAB_SECTIONS).flat() as readonly string[]);
    for (const section of Object.keys(SECTION_SETTING_KEYS)) {
      expect(sections.has(section), `${section} is not a section this page draws`).toBe(true);
    }
  });

  it("gives every kind of hit a word in both languages", () => {
    for (const origin of SETTINGS_HIT_ORIGINS) {
      expect(dict[settingsHitKindKey(origin)], `${origin} has no word`).toBeDefined();
    }
    // And the union really is these three: a manifest entry with a fourth
    // origin would draw a raw dict key at the reader.
    for (const hit of manifest) {
      expect(SETTINGS_HIT_ORIGINS, hit.id).toContain(hit.origin);
    }
  });

  it("gives every section a heading the dictionary really carries", () => {
    for (const [section, key] of Object.entries(SETTINGS_SECTION_LABEL_KEY)) {
      expect(dict[key], `${section} points at the missing dict key ${key}`).toBeDefined();
    }
    const sections = Object.values(SETTINGS_TAB_SECTIONS).flat() as readonly string[];
    expect(Object.keys(SETTINGS_SECTION_LABEL_KEY).sort()).toEqual([...sections].sort());
  });
});

// ---- the merge seam with card 379: a saveable key the page does not draw ---

/** A module of this tree, by its path relative to this file. */
const here = (rel: string): string => new URL(rel, import.meta.url).href;

/** A relative import resolved to the source file it names, or null when it
 *  names none (a directory, an asset). */
function resolveImport(spec: string, from: string): string | null {
  for (const ext of ["", ".tsx", ".ts"]) {
    const url = new URL(spec + ext, from);
    if (/\.tsx?$/.test(url.pathname) && existsSync(fileURLToPath(url))) return url.href;
  }
  return null;
}

/**
 * Every module the settings page renders from, read off the imports of
 * SettingsPanel.tsx and followed through the tree. Derived rather than listed,
 * so a section component the page starts importing is inside on that day. The
 * name rule the reach walker uses (a file ending in Settings.tsx) does not
 * answer this question: PlusMenuSettings.tsx carries that ending on purpose
 * and is the composer's plus menu.
 */
function pageModules(): Set<string> {
  const seen = new Set<string>();
  const todo = [here("./SettingsPanel.tsx")];
  while (todo.length > 0) {
    const url = todo.pop() as string;
    if (seen.has(url)) continue;
    seen.add(url);
    for (const m of stripComments(read(url, import.meta.url)).matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)"/g)) {
      const next = resolveImport(m[1] as string, url);
      if (next !== null) todo.push(next);
    }
  }
  return seen;
}

/** The keys every `<ReachBlock>` in a source declares, comments blanked first
 *  so prose that quotes the tag is not a block. The same tag shape the reach
 *  walker in settingsReach.test.tsx reads. */
function reachKeysIn(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/<ReachBlock\b([^>]*)>/g)) {
    const list = /fields=\{\[([^\]]*)\]\}/.exec(m[1] ?? "")?.[1] ?? "";
    for (const f of list.matchAll(/"([^"]+)"/g)) out.push(f[1] as string);
  }
  return out;
}

/** Every key a reach block on the settings page declares. */
function keysDrawnOnPage(): Set<string> {
  return new Set([...pageModules()].flatMap((url) => reachKeysIn(read(url, import.meta.url))));
}

describe("a saveable key the settings page does not draw", () => {
  it("reads a block's keys over several lines, and not a block quoted in a comment", () => {
    const fixture = [
      '// <ReachBlock lang={lang} fields={["quotedLine"]}>',
      '/* <ReachBlock lang={lang} fields={["quotedBlock"]}> */',
      "<ReachBlock",
      "  lang={lang}",
      '  fields={["first", "second"]}',
      ">",
      "</ReachBlock>",
      '<ReachBlock lang={lang} fields={["third"]} />',
    ].join("\n");
    expect(reachKeysIn(fixture)).toEqual(["first", "second", "third"]);
  });

  it("reads the page's modules off its imports, and the composer's menus are not among them", () => {
    const page = pageModules();
    // The positive half: the page itself and three components that draw its fields.
    for (const name of [
      "./SettingsPanel.tsx",
      "./ProgressGuardSettings.tsx",
      "./SkillsMcpSettings.tsx",
      "./DockWidthSettings.tsx",
    ]) {
      expect(page.has(here(name)), `${name} is not read as part of the settings page`).toBe(true);
    }
    // The composer's side: the rtk section, the menu that mounts it, the plus
    // menu whose name ends in Settings.tsx, and the chat.
    for (const name of [
      "./RtkFilterSection.tsx",
      "./DisclosureMenu.tsx",
      "./PlusMenuSettings.tsx",
      "./Chat.tsx",
    ]) {
      expect(page.has(here(name)), `${name} is read as part of the settings page`).toBe(false);
    }
  });

  it("files a key under a section only when a reach block on the page draws it", () => {
    // The fastest green for this seam was to type rtkFilter into a section.
    // The search would then open a room that has no rtk switch in it, and
    // this refuses that edit.
    const drawn = keysDrawnOnPage();
    for (const [section, keys] of Object.entries(SECTION_SETTING_KEYS)) {
      for (const key of keys) {
        expect(
          drawn.has(key),
          `${key} is filed under ${section}, and no reach block on the settings page draws it`,
        ).toBe(true);
      }
    }
  });

  it("names, for a key drawn elsewhere, a component outside the page that draws it", () => {
    // Card 379's switch, where the owner put it: the bottom of the composer's
    // settings menu, and nowhere on this page.
    expect(OFF_PAGE_SETTING_KEYS.rtkFilter).toBe("RtkFilterSection.tsx");
    const page = pageModules();
    const drawn = keysDrawnOnPage();
    for (const [key, file] of Object.entries(OFF_PAGE_SETTING_KEYS)) {
      const url = here(`./${file}`);
      expect(existsSync(fileURLToPath(url)), `${file} does not exist`).toBe(true);
      const blocks = reachKeysIn(read(url, import.meta.url));
      expect(blocks, `${file} draws no reach block for ${key}`).toContain(key);
      expect(page.has(url), `${file} is on the settings page; file ${key} under a section`).toBe(false);
      expect(drawn.has(key), `the settings page draws ${key} too; file it under a section`).toBe(false);
    }
  });
});

// ---- card 493: a key whose control draws no reach block, or has no control ---

/** Every non-test source module under src, as file URLs. */
function sourceModules(): string[] {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    out.push(new URL(`file://${entry.parentPath}/${entry.name}`).href);
  }
  return out;
}

/** Whether a source names a key as a quoted string or as an object key,
 *  comments blanked first. */
function namesKey(src: string, key: string): boolean {
  const code = stripComments(src);
  return code.includes(`"${key}"`) || new RegExp(`(^|[\\s{,])${key}\\s*:`, "m").test(code);
}

describe("a saveable key with no reach block, or with no control at all", () => {
  it("reads a key named in code, and not a key quoted in a comment", () => {
    expect(namesKey('spec("baseUrl", "text")', "baseUrl")).toBe(true);
    expect(namesKey("const ROWS = {\n  careParagraph: { label: 1 },\n};", "careParagraph")).toBe(true);
    expect(namesKey('// spec("baseUrl", "text")', "baseUrl")).toBe(false);
    expect(namesKey("const x = notbaseUrl;", "baseUrl")).toBe(false);
  });

  it("finds the source modules, test files left out", () => {
    const all = sourceModules();
    expect(all).toContain(here("./LocalModeSection.tsx"));
    expect(all).toContain(here("./workspaceGear.ts"));
    expect(all).not.toContain(here("./settingsSearch.test.tsx"));
  });

  it("names, for a key with a control outside the page, a module that names the key and draws no reach block for it", () => {
    // The Local mode rows of card 493 stand in the composer gear and carry a
    // note of their own; the search cannot open the gear, so it finds none
    // of them, and this says where they are instead.
    expect(OFF_PAGE_NO_REACH_KEYS.sessionsPerChat).toBe("LocalModeSection.tsx");
    const page = pageModules();
    const drawn = keysDrawnOnPage();
    for (const [key, file] of Object.entries(OFF_PAGE_NO_REACH_KEYS)) {
      expect(drawn.has(key), `the settings page draws ${key}; file it under a section`).toBe(false);
      if (file === null) continue;
      const url = here(`./${file}`);
      expect(existsSync(fileURLToPath(url)), `${file} does not exist`).toBe(true);
      const src = read(url, import.meta.url);
      expect(namesKey(src, key), `${file} does not name ${key}`).toBe(true);
      expect(
        reachKeysIn(src),
        `${file} draws a reach block for ${key}; file it in OFF_PAGE_SETTING_KEYS`,
      ).not.toContain(key);
      expect(page.has(url), `${file} is on the settings page; file ${key} under a section`).toBe(false);
    }
  });

  it("holds a key with no control to that word: no module but the two tables names it", () => {
    // null is a claim that nothing in the app sets the key. The day a control
    // for it appears, its module names the key and this turns red, so the
    // control gets placed instead of staying invisible to the search.
    const nulls = Object.entries(OFF_PAGE_NO_REACH_KEYS).filter(([, file]) => file === null);
    expect(nulls.length).toBeGreaterThan(0);
    const tables = new Set([here("./settingsReach.tsx"), here("./settingsSearch.ts")]);
    for (const url of sourceModules()) {
      if (tables.has(url)) continue;
      const src = read(url, import.meta.url);
      for (const [key] of nulls) {
        expect(namesKey(src, key), `${url} names ${key}, which the table says no control sets`).toBe(false);
      }
    }
  });
});

// ---- criterion 3 -----------------------------------------------------------

describe("a query matches label, key and note, each on its own", () => {
  it("finds a section, AND its fields, by a word that lives only in its heading", () => {
    // The second half is what makes this a test of the LABEL. A section entry
    // draws its own heading as its title, so matching one proves nothing about
    // which part of the entry the query was held against; a field under that
    // heading carries the word nowhere else.
    const heading = dict[SETTINGS_SECTION_LABEL_KEY.observability].en;
    const hits = matchSettings(manifest, heading);
    expect(hits.some((h) => h.origin === "section" && h.section === "observability")).toBe(true);
    expect(
      hits.some((h) => h.origin === "field" && h.key === "otlpEndpoint"),
      "a field is not reachable by the heading it stands under",
    ).toBe(true);
  });

  it("finds a registry row by a settings key that appears nowhere else in it", () => {
    // Derived, not typed: a row whose key is absent from its constant name,
    // its owner, its value and its javadoc. Only the key field can match it,
    // so a haystack that stopped reading keys would drop it.
    const hidden = registry.find((n) => {
      if (n.key === "") return false;
      const rest = `${n.owner} ${n.field} ${n.value} ${n.explanation}`.toLowerCase();
      return !rest.includes(n.key.toLowerCase());
    });
    expect(hidden, "every keyed row now spells its key in its own prose").toBeDefined();
    const number = hidden as GoverningNumber;
    const hits = matchSettings(manifest, number.key);
    expect(
      hits.some((h) => h.id === `number:${number.owner}#${number.field}`),
      `${number.key} no longer reaches ${number.field}`,
    ).toBe(true);
  });

  it("finds a saveable field by its settings key", () => {
    const hits = matchSettings(manifest, "otlpBasicAuth");
    expect(hits.some((h) => h.origin === "field" && h.key === "otlpBasicAuth")).toBe(true);
  });

  it("finds a registry row by prose that appears only in its explanation", () => {
    // Taken from the registry itself rather than typed: a phrase this file
    // invented would pin nothing once the javadoc moved.
    const withProse = registry.find((n) => n.explanation.trim().split(/\s+/).length > 6);
    expect(withProse, "no registry row carries prose").toBeDefined();
    const number = withProse as GoverningNumber;
    const phrase = number.explanation.trim().split(/\s+/).slice(0, 6).join(" ");
    const hits = matchSettings(manifest, phrase);
    expect(
      hits.some((h) => h.id === `number:${number.owner}#${number.field}`),
      `prose search missed ${number.field}`,
    ).toBe(true);
  });

  it("matches nothing on a query no source carries", () => {
    expect(matchSettings(manifest, "zzzz-no-such-setting-zzzz")).toEqual([]);
  });

  it("shows everything again when the box is cleared", () => {
    expect(matchSettings(manifest, "   ").length).toBe(manifest.length);
  });
});

// ---- criterion 4 -----------------------------------------------------------

describe("a hit outside the open room is one click away", () => {
  it("hands the panel the room and the anchor the deep link already uses", () => {
    const hit = manifest.find((h) => h.section === "limits");
    expect(hit, "the limits section is missing from the manifest").toBeDefined();
    const found = hit as { tab: SettingsTab };
    expect(found.tab).toBe("system");
    // One id scheme, not two: the search points at exactly the anchor
    // `sectionAnchorId` produces for every section the page draws.
    for (const section of Object.values(SETTINGS_TAB_SECTIONS).flat()) {
      const entry = manifest.find((h) => h.origin === "section" && h.section === section);
      expect(settingsHitAnchorId(entry as never), section).toBe(sectionAnchorId(section));
    }
  });

  it("a click opens the hit's own room and scrolls to its section's anchor", () => {
    // Fix round 2026-09-24. The old wiring check looked for `pickTab(` in the
    // panel, which the room tabs already call, so a result that opened the
    // wrong room stayed green. The click is now a function the test can watch.
    // Two hits in two different rooms, so a constant room cannot pass either.
    const number = matchSettings(manifest, "maxTurns").find((h) => h.origin === "number");
    const field = matchSettings(manifest, "commandTimeoutSeconds").find((h) => h.origin === "field");
    expect(number, "no registry row answers maxTurns").toBeDefined();
    expect(field, "no saveable field answers commandTimeoutSeconds").toBeDefined();
    for (const [hit, room, section] of [
      [number as SettingsHit, "system", "limits"],
      [field as SettingsHit, "permissions", "progress"],
    ] as const) {
      const picked: SettingsTab[] = [];
      const scrolled: string[] = [];
      openSettingsHit(
        hit,
        (tab) => picked.push(tab),
        (anchor) => scrolled.push(anchor),
      );
      expect(picked, `${hit.id} opened the wrong room`).toEqual([room]);
      expect(scrolled, `${hit.id} scrolled to the wrong anchor`).toEqual([sectionAnchorId(section)]);
    }
  });

  it("is wired into the panel's own room picker", () => {
    const panel = stripComments(read("./SettingsPanel.tsx", import.meta.url));
    expect(panel, "the panel draws no search box").toContain("<SettingsSearch");
    expect(panel, "a result does not reach the panel's click handler").toContain("onPick={pickHit}");
    // The panel hands its OWN room picker to the click effect. A handler that
    // opened a room by any other path would skip what pickTab does on the way.
    // And the third argument is the named scroller below, so the scroll half
    // of the click is pinned by a test of its own rather than by nothing.
    expect(panel, "a search hit does not open its room through pickTab and scroll with the scroller").toMatch(
      /const pickHit = \(hit: SettingsHit\): void => \{\s*openSettingsHit\(hit, pickTab, scrollToSettingsAnchor\);\s*\};/,
    );
  });

  it("the scroller brings the anchor it is handed into view, one frame later", () => {
    // Fix round 2026-09-24, second pass. The panel's scroll callback was an
    // inline arrow no test reached: replacing its body with nothing stayed
    // green. It is a named function now, driven here against stand-in globals.
    const frames: (() => void)[] = [];
    const scrolled: { id: string; how: unknown }[] = [];
    vi.stubGlobal("window", { requestAnimationFrame: (run: () => void) => frames.push(run) });
    vi.stubGlobal("document", {
      getElementById: (id: string) =>
        id === "no-such-anchor" ? null : { scrollIntoView: (how: unknown) => scrolled.push({ id, how }) },
    });
    try {
      for (const section of ["limits", "progress"] as const) {
        const anchor = sectionAnchorId(section);
        scrollToSettingsAnchor(anchor);
        expect(scrolled, "scrolled before the room it points into had rendered").toEqual([]);
        expect(frames.length, "no frame was asked for").toBe(1);
        (frames.shift() as () => void)();
        expect(scrolled, `${anchor} was not brought into view`).toEqual([
          { id: anchor, how: { block: "start" } },
        ]);
        scrolled.length = 0;
      }
      // An anchor the page does not draw scrolls nothing and throws nothing.
      scrollToSettingsAnchor("no-such-anchor");
      expect(() => (frames.shift() as () => void)()).not.toThrow();
      expect(scrolled).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("each result button hands its own hit to onPick", () => {
    // Fix round 2026-09-24, second pass. The button's click handler was not
    // pinned at all: a button that picked nothing stayed green. The box is a
    // plain function without hooks, so it is called and its elements walked.
    const hits = [
      matchSettings(manifest, "maxTurns").find((h) => h.origin === "number"),
      matchSettings(manifest, "commandTimeoutSeconds").find((h) => h.origin === "field"),
    ] as SettingsHit[];
    expect(hits.every(Boolean), "the two probe hits are missing from the manifest").toBe(true);
    const picked: SettingsHit[] = [];
    const tree = SettingsSearch({
      lang: "en",
      query: "x",
      onQuery: () => {},
      hits,
      onPick: (h) => picked.push(h),
    });
    const buttons: ReactElement<{ className?: string; onClick?: () => void }>[] = [];
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!isValidElement(node)) return;
      const el = node as ReactElement<{ children?: ReactNode; className?: string; onClick?: () => void }>;
      if (el.type === "button" && el.props.className === "settings-hit") buttons.push(el);
      walk(el.props.children);
    };
    walk(tree);
    expect(buttons.length, "the box drew no result button per hit").toBe(hits.length);
    for (const button of buttons) button.props.onClick?.();
    expect(picked.length, "a result button handed nothing to onPick").toBe(hits.length);
    picked.forEach((got, i) => expect(got, `button ${i} handed over another hit`).toBe(hits[i]));
  });
});

// ---- criterion 9 (owner call 9) -------------------------------------------

describe("two registry rows share one settings key", () => {
  it("lists both rows for maxTurns rather than merging them", () => {
    const rows = registry.filter((n) => n.key === "maxTurns");
    expect(rows.length, "the registry no longer carries maxTurns twice").toBeGreaterThan(1);
    const hits = matchSettings(manifest, "maxTurns");
    for (const number of rows) {
      expect(
        hits.some((h) => h.id === `number:${number.owner}#${number.field}`),
        `${number.owner} dropped out of the maxTurns result`,
      ).toBe(true);
    }
    // And the saveable field itself is a result too, beside the two rows.
    expect(hits.some((h) => h.origin === "field" && h.key === "maxTurns")).toBe(true);
  });
});

describe("the haystack is the rule the limits box already taught", () => {
  it("joins what a reader can see: heading, key and the code's own words", () => {
    const number = registry[0];
    const hit = manifest.find((h) => h.id === `number:${number.owner}#${number.field}`);
    const hay = settingsSearchHaystack(hit as never);
    expect(hay).toContain(number.field.toLowerCase());
    expect(hay).toContain(number.explanation.toLowerCase().slice(0, 20));
  });
});

// Card 411: the Skills view reads as one narrow, left aligned column with the
// control of every row at its left edge and the installed skills collapsed
// per namespace. Owner, 2026-09-25: "Mach den Button vielleicht auch einfach
// nach links" and "alle Skills, die ich installiert habe, möchte ich auch
// eingeklappt haben, so wie unten die Pakete."
//
// No DOM here (house rule): `renderToStaticMarkup` gives what a group shows,
// and the element tree gives the wiring. InstalledGroup is hook-free for that,
// the way CataloguePack is. Geometry (left edges, gaps, hover colour) is the
// browser stage's; this file pins the markup order and the declarations it
// rests on.

import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CataloguePack, InstalledGroup, InstalledShelf } from "./SkillsMcpSettings";
import { installedGroups, packGroups, type InstalledSkill } from "../state/skillPacks";
import type { CatalogueRow } from "../state/skillInstall";
import { dict, type Lang } from "../i18n/i18n";
import { blockOf, read, stripComments } from "../testkit/source";

const css = read("../styles/surfaces.css", import.meta.url);
const manager = read("./SkillsMcpSettings.tsx", import.meta.url);

const skill = (name: string, source: "user" | "project" = "user", disabled = false): InstalledSkill => {
  const colon = name.indexOf(":");
  return {
    name,
    folder: colon < 0 ? name : name.slice(colon + 1),
    pack: colon < 0 ? null : name.slice(0, colon),
    description: `${name} does one thing.`,
    source,
    disabled,
  };
};

const ROWS: InstalledSkill[] = [
  skill("brainstorming"),
  skill("matt-pocock:grill-me"),
  skill("matt-pocock:handoff", "user", true),
  skill("spectroscope:research"),
  skill("superpowers:brainstorming", "project"),
  skill("verification"),
];

const catRow = (pack: string, name: string, installed = false): CatalogueRow => ({
  id: `${pack}/${name}`,
  name,
  pack,
  description: `${name} does one thing.`,
  licence: "MIT",
  repo: "https://example.com/repo",
  commit: "0".repeat(40),
  files: 3,
  bytes: 1200,
  installed,
  root: installed ? "user" : null,
});

type Btn = ReactElement<{
  onClick?: () => void;
  className?: string;
  role?: string;
  "aria-label"?: string;
  "aria-checked"?: boolean;
  "aria-expanded"?: boolean;
  children?: ReactNode;
}>;

/** Every button in an element tree, in document order; hook-free components are called in place. */
function buttons(node: ReactNode): Btn[] {
  const found: Btn[] = [];
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
    if (el.type === "button") found.push(el as Btn);
    walk(el.props.children);
  };
  walk(node);
  return found;
}

const count = (html: string, cls: string): number =>
  [...html.matchAll(/class="([^"]*)"/g)].filter((m) => (m[1] ?? "").split(/\s+/).includes(cls)).length;

function group(
  namespace: string | null,
  over: Partial<{
    open: boolean;
    lang: Lang;
    armed: string | null;
    onToggleOpen: () => void;
    onSwitch: (row: InstalledSkill) => void;
    onRemove: (row: InstalledSkill) => void;
  }> = {},
): ReactElement {
  const found = installedGroups(ROWS).find((g) => g.namespace === namespace);
  if (found === undefined) throw new Error(`no group ${String(namespace)}`);
  return (
    <InstalledGroup
      group={found}
      lang={over.lang ?? "en"}
      open={over.open ?? false}
      onToggleOpen={over.onToggleOpen ?? (() => {})}
      armed={over.armed ?? null}
      onSwitch={over.onSwitch ?? (() => {})}
      onRemove={over.onRemove ?? (() => {})}
    />
  );
}

const shelf = (lang: Lang = "en"): string =>
  renderToStaticMarkup(
    <InstalledShelf skills={ROWS} lang={lang} armed={null} onSwitch={() => {}} onRemove={() => {}} />,
  );

describe("rule C and criterion 11: the installed skills, collapsed per namespace", () => {
  it("on a fresh render shows one closed header per namespace and no skill row", () => {
    const html = shelf();

    expect(count(html, "skset-pack-head")).toBe(4);
    expect(count(html, "skset-row")).toBe(0);
    expect([...html.matchAll(/aria-expanded="false"/g)]).toHaveLength(4);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain("grill-me does one thing.");
  });

  it("names each namespace and the group of skills without one, each with its count", () => {
    const html = shelf();

    expect(html).toContain(dict["skset.noNamespace"].en);
    for (const ns of ["matt-pocock", "spectroscope", "superpowers"]) expect(html).toContain(`>${ns}<`);
    expect([...html.matchAll(/>2 installed</g)]).toHaveLength(2);
    expect([...html.matchAll(/>1 installed</g)]).toHaveLength(2);
    expect(html.indexOf(dict["skset.noNamespace"].en)).toBeLessThan(html.indexOf(">matt-pocock<"));
  });

  it("says the count and the missing namespace in German too", () => {
    const html = shelf("de");
    expect(html).toContain(">2 installiert<");
    expect(html).toContain(dict["skset.noNamespace"].de);
  });

  it("is a list of its own, told apart from the catalogue's packs", () => {
    expect(shelf()).toMatch(/^<ul class="skset-packs skset-packs--installed">/);
  });

  it("opens a group through its header's own button", () => {
    const onToggleOpen = vi.fn();
    const [toggle] = buttons(group("matt-pocock", { onToggleOpen })).filter((b) =>
      (b.props.className ?? "").split(/\s+/).includes("skset-pack-toggle"),
    );

    expect(toggle.props["aria-expanded"]).toBe(false);
    toggle.props.onClick?.();
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
  });

  it("opened, lists exactly that group's rows", () => {
    const html = renderToStaticMarkup(group("matt-pocock", { open: true }));

    expect(html).toContain('aria-expanded="true"');
    expect(count(html, "skset-row")).toBe(2);
    expect(html).toContain("matt-pocock:grill-me does one thing.");
    expect(html).toContain("matt-pocock:handoff does one thing.");
    expect(html).not.toContain("brainstorming does one thing.");
  });
});

describe("rule B and criterion 10: the control stands before the name", () => {
  it("an installed row reads switch, name, source, description, then the remove button", () => {
    const html = renderToStaticMarkup(group("matt-pocock", { open: true }));
    expect(html).toMatch(
      /<li class="skset-row"><button[^>]*role="switch"[^>]*>[\s\S]*?<\/button><span class="skset-name mono">matt-pocock:grill-me<\/span><span class="wsg-scope-tag">user<\/span><span class="skset-desc"[^>]*>matt-pocock:grill-me does one thing.<\/span><button[^>]*class="skset-del"[^>]*>✕<\/button><\/li>/,
    );
  });

  it("a project row has its switch first and no remove button", () => {
    const html = renderToStaticMarkup(group("superpowers", { open: true }));
    expect(html).toMatch(
      /<li class="skset-row"><button[^>]*role="switch"[^>]*>[\s\S]*?<\/button><span class="skset-name mono">superpowers:brainstorming<\/span><span class="wsg-scope-tag">project<\/span><span class="skset-desc"[^>]*>[^<]*<\/span><\/li>/,
    );
    expect(count(html, "skset-del")).toBe(0);
  });

  it("a catalogue row reads switch, name, pack, description", () => {
    const [alpha] = packGroups([catRow("alpha", "a1", true), catRow("alpha", "a2")]);
    const html = renderToStaticMarkup(
      <CataloguePack
        group={alpha}
        lang="en"
        open
        onToggle={() => {}}
        busy={false}
        pendingSet={null}
        installingId={null}
        removingId={null}
        refused={null}
        reload={() => {}}
      />,
    );
    expect(html).toMatch(
      /<li class="skset-row"><button[^>]*role="switch"[^>]*>[\s\S]*?<\/button><span class="skset-name mono">a1<\/span><span class="wsg-scope-tag">alpha<\/span><span class="skset-desc"[^>]*>a1 does one thing.<\/span><\/li>/,
    );
  });

  it("the switch of a row acts on that row and no other", () => {
    const onSwitch = vi.fn();
    const onRemove = vi.fn();
    const all = buttons(group("matt-pocock", { open: true, onSwitch, onRemove }));
    const switches = all.filter((b) => b.props.role === "switch");
    const removes = all.filter((b) => (b.props.className ?? "").split(/\s+/).includes("skset-del"));

    expect(switches.map((s) => s.props["aria-checked"])).toEqual([true, false]);
    switches[1].props.onClick?.();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][0].name).toBe("matt-pocock:handoff");
    removes[0].props.onClick?.();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0][0].name).toBe("matt-pocock:grill-me");
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
});

describe("criterion 4: each control says which skill it is", () => {
  it("an installed row's switch names its action and the skill, and two rows by two names", () => {
    const switches = buttons(group("matt-pocock", { open: true })).filter((b) => b.props.role === "switch");
    expect(switches.map((s) => s.props["aria-label"])).toEqual([
      "enable matt-pocock:grill-me",
      "enable matt-pocock:handoff",
    ]);
  });

  it("an installed row's remove button names the skill it deletes, armed or not", () => {
    const quiet = buttons(group("matt-pocock", { open: true })).filter((b) =>
      (b.props.className ?? "").split(/\s+/).includes("skset-del"),
    );
    expect(quiet.map((b) => b.props["aria-label"])).toEqual([
      "delete matt-pocock:grill-me",
      "delete matt-pocock:handoff",
    ]);

    const armedHtml = renderToStaticMarkup(
      group("matt-pocock", { open: true, armed: "matt-pocock:grill-me" }),
    );
    expect(armedHtml).toContain('aria-label="sure? delete matt-pocock:grill-me"');
    expect(armedHtml).toContain(">sure?</button>");

    const de = buttons(group("matt-pocock", { open: true, lang: "de" })).filter((b) =>
      (b.props.className ?? "").split(/\s+/).includes("skset-del"),
    );
    expect(de[0].props["aria-label"]).toBe("matt-pocock:grill-me löschen");
  });

  it("a catalogue row's switch names its action and the name the agent calls, one name per row", () => {
    const [alpha] = packGroups([catRow("alpha", "a1", true), catRow("alpha", "wait-what")]);
    const switches = buttons(
      <CataloguePack
        group={alpha}
        lang="en"
        open
        onToggle={() => {}}
        busy={false}
        pendingSet={null}
        installingId={null}
        removingId={null}
        refused={null}
        reload={() => {}}
      />,
    ).filter((b) => b.props.role === "switch");

    expect(switches.map((s) => s.props["aria-label"])).toEqual([
      "install alpha:a1",
      "install alpha:wait-what",
    ]);
  });

  it("has German and English for every new key, and no dash character in either", () => {
    for (const key of [
      "skset.installedCount",
      "skset.noNamespace",
      "skset.deleteLabel",
      "skset.deleteArmedLabel",
      "skset.enableLabel",
      "skset.installLabel",
    ]) {
      expect(dict[key], key).toBeDefined();
      for (const lang of ["de", "en"] as const) {
        expect(dict[key][lang], `${key}.${lang}`).toBeTruthy();
        expect(dict[key][lang], `${key}.${lang}`).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});

/**
 * The name a control is announced by: its aria-label, else its text without
 * the aria-hidden parts. Text of separate elements is joined with a space;
 * the browser stage reads the names the browser computes.
 */
function nameOf(btn: Btn): string {
  const label = btn.props["aria-label"];
  if (label !== undefined) return label;
  const text = (n: ReactNode): string[] => {
    if (typeof n === "string" || typeof n === "number") return [String(n)];
    if (Array.isArray(n)) return n.flatMap(text);
    if (!isValidElement(n)) return [];
    const p = n.props as { children?: ReactNode; "aria-hidden"?: boolean | "true" | "false" };
    if (p["aria-hidden"] === true || p["aria-hidden"] === "true") return [];
    return text(p.children);
  };
  return text(btn.props.children)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join(" ");
}

// The matt-pocock pack of the catalogue, with grill-me and handoff copied in
// (the installed group above lists both) and wait-what not yet.
const [MATT_PACK] = packGroups([
  catRow("matt-pocock", "grill-me", true),
  catRow("matt-pocock", "handoff", true),
  catRow("matt-pocock", "wait-what"),
]);

/** The installed group and the catalogue pack of one namespace, both open. */
const sideBySide = (lang: Lang = "en"): ReactElement => (
  <div>
    {group("matt-pocock", { open: true, lang })}
    <CataloguePack
      group={MATT_PACK}
      lang={lang}
      open
      onToggle={() => {}}
      busy={false}
      pendingSet={null}
      installingId={null}
      removingId={null}
      refused={null}
      reload={() => {}}
    />
  </div>
);

describe("criterion 4 with the installed group and the catalogue pack of one skill both open", () => {
  it("the skill's installed switch and its catalogue switch carry two names, each with its action", () => {
    const names = buttons(sideBySide())
      .filter((b) => b.props.role === "switch")
      .map(nameOf);

    expect(names).toEqual([
      "enable matt-pocock:grill-me",
      "enable matt-pocock:handoff",
      "install matt-pocock:grill-me",
      "install matt-pocock:handoff",
      "install matt-pocock:wait-what",
    ]);
    expect(names.filter((n) => n === "enable matt-pocock:grill-me")).toHaveLength(1);
    expect(names.filter((n) => n === "install matt-pocock:grill-me")).toHaveLength(1);
  });

  it("no two of the eleven controls in that state share a name, in English or German", () => {
    for (const lang of ["en", "de"] as const) {
      const names = buttons(sideBySide(lang)).map(nameOf);
      expect(names, lang).toHaveLength(11);
      expect(
        names.every((n) => n !== ""),
        lang,
      ).toBe(true);
      expect(new Set(names).size, `${lang}: ${names.join(" | ")}`).toBe(names.length);
    }
  });

  it("names the action in German", () => {
    const names = buttons(sideBySide("de"))
      .filter((b) => b.props.role === "switch")
      .map(nameOf);

    expect(names).toEqual([
      "matt-pocock:grill-me einschalten",
      "matt-pocock:handoff einschalten",
      "matt-pocock:grill-me installieren",
      "matt-pocock:handoff installieren",
      "matt-pocock:wait-what installieren",
    ]);
  });

  it("a switch keeps its name when it flips, and aria-checked says whether it is on", () => {
    const flipped = ROWS.map((r) => (r.name === "matt-pocock:grill-me" ? { ...r, disabled: true } : r));
    const [installedAfter] = installedGroups(flipped).filter((g) => g.namespace === "matt-pocock");
    const [packAfter] = packGroups([
      catRow("matt-pocock", "grill-me", true),
      catRow("matt-pocock", "handoff", true),
      catRow("matt-pocock", "wait-what", true),
    ]);
    const switchesOf = (node: ReactNode): [string, boolean | undefined][] =>
      buttons(node)
        .filter((b) => b.props.role === "switch")
        .map((s) => [nameOf(s), s.props["aria-checked"]]);
    const pack = (g: typeof packAfter): ReactElement => (
      <CataloguePack
        group={g}
        lang="en"
        open
        onToggle={() => {}}
        busy={false}
        pendingSet={null}
        installingId={null}
        removingId={null}
        refused={null}
        reload={() => {}}
      />
    );

    const installedBefore = switchesOf(group("matt-pocock", { open: true }))[0];
    const installedFlipped = switchesOf(
      <InstalledGroup
        group={installedAfter}
        lang="en"
        open
        onToggleOpen={() => {}}
        armed={null}
        onSwitch={() => {}}
        onRemove={() => {}}
      />,
    )[0];
    expect([installedBefore, installedFlipped]).toEqual([
      ["enable matt-pocock:grill-me", true],
      ["enable matt-pocock:grill-me", false],
    ]);

    const catalogueBefore = switchesOf(pack(MATT_PACK))[2];
    const catalogueFlipped = switchesOf(pack(packAfter))[2];
    expect([catalogueBefore, catalogueFlipped]).toEqual([
      ["install matt-pocock:wait-what", false],
      ["install matt-pocock:wait-what", true],
    ]);
  });
});

describe("criteria 2 and 3: the row is one unit", () => {
  it("the description grows no wider than its text, so the remove button follows the text", () => {
    const desc = blockOf(css, ".skset-desc");
    expect(desc).toMatch(/max-width:\s*max-content/);
    expect(desc).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("the description gives way before the name does", () => {
    // Measured in installed Chrome on e37a84aa (kanban/evidence/411/loop/
    // after-e37a84aa): with `flex: 0 1 auto` the description and the name
    // shrank in proportion to their widths, and in the 646 px column the name
    // matt-pocock:code-review wrapped onto seven lines. A zero basis leaves
    // the name its width until the description has none left.
    const desc = blockOf(css, ".skset-desc");
    expect(desc).toMatch(/flex:\s*1(\s+1\s+0%?)?\s*;/);
    expect(desc).toMatch(/min-width:\s*0/);
  });

  it("hovering or focusing anywhere in a row paints the whole row", () => {
    expect(blockOf(css, ".skset-row:hover")).toMatch(/background:\s*var\(--surface-2\)/);
    expect(blockOf(css, ".skset-row:focus-within")).toMatch(/background:\s*var\(--surface-2\)/);
  });
});

describe("the manager draws the installed list through the shelf", () => {
  it("mounts InstalledShelf once, inside the skills ReachBlock, and maps no flat row list itself", () => {
    const code = stripComments(manager);
    const body = /export function SkillsSettings[\s\S]*?\n}\n/.exec(code)?.[0] ?? "";

    expect(body.split("<InstalledShelf").length - 1).toBe(1);
    expect(body).toMatch(
      /<ReachBlock[^>]*fields=\{\["skills"\]\}>[\s\S]*?<InstalledShelf[\s\S]*?<\/ReachBlock>/,
    );
    expect(body).not.toContain("skills.map(");
  });
});

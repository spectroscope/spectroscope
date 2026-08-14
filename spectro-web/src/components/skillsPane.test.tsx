// The skills segment's surface (card 225): the rail's fifth row opens a view
// that LISTS — the namespaced catalogue and everything installed, each with its
// name, its one-line description, its enabled state and its namespace in plain
// sight. The fast switches live elsewhere (settings today, card 224's plus menu
// when it lands); this view is the ledger, so what these tests pin is that it
// lists honestly and changes nothing.
//
// Same idiom as sidebarStickyHead.test.tsx: `renderToStaticMarkup`, no DOM.
// The pure surface is rendered with fixtures; the container's fetch — the one
// thing a static render cannot reach — is pinned by reading the source, the way
// the settings walker reads its page.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsSurface, type SkillsViewRow } from "./SkillsPane";
import type { CatalogueRow } from "../state/skillInstall";
import { reachOf } from "./settingsReach";
import { dict } from "../i18n/i18n";

/** Three installed skills: two namespaced (one from each root), one bare and
 *  switched off — the states the view has to tell apart. */
const SKILLS: SkillsViewRow[] = [
  {
    name: "anthropic-skills:pdf",
    folder: "pdf",
    pack: "anthropic-skills",
    description: "Read, write and fill PDF files.",
    source: "user",
    disabled: false,
  },
  {
    name: "release-notes",
    folder: "release-notes",
    pack: null,
    description: "The house voice for release notes.",
    source: "project",
    disabled: true,
  },
  {
    name: "superpowers:brainstorming",
    folder: "brainstorming",
    pack: "superpowers",
    description: "Explore intent before building.",
    source: "user",
    disabled: false,
  },
];

/** One catalogue row already installed, one still on the shelf. */
const CATALOGUE: CatalogueRow[] = [
  {
    id: "anthropic-skills/pdf",
    name: "pdf",
    pack: "anthropic-skills",
    description: "Read, write and fill PDF files.",
    licence: "MIT",
    repo: "example/skills",
    commit: "abc1234",
    files: 4,
    bytes: 2048,
    installed: true,
  },
  {
    id: "anthropic-skills/docx",
    name: "docx",
    pack: "anthropic-skills",
    description: "Create and edit Word documents.",
    licence: "MIT",
    repo: "example/skills",
    commit: "abc1234",
    files: 4,
    bytes: 2048,
    installed: false,
  },
];

function surface(lang: "en" | "de"): string {
  return renderToStaticMarkup(
    <SkillsSurface lang={lang} skills={SKILLS} catalogue={CATALOGUE} onManage={() => {}} />,
  );
}

const en = surface("en");
const de = surface("de");

describe("the view lists what is installed, namespace in plain sight", () => {
  it("prints every skill's full name, description and namespace tag", () => {
    for (const row of SKILLS) {
      expect(en).toContain(row.name);
      expect(en).toContain(row.description);
    }
    // The namespace is not only inside the colon name: each namespaced row
    // wears its pack as a tag of its own, and a bare skill wears its root.
    expect(en).toContain(">anthropic-skills<");
    expect(en).toContain(">superpowers<");
    for (const row of SKILLS) {
      expect(en).toContain(`>${row.source}<`);
    }
  });

  it("says each skill's enabled state, as data and as a word", () => {
    // One fixture is off, two are on — exact counts, so a view that paints
    // every row "on" (or reads the wrong flag) goes red rather than pretty.
    expect(en.split('data-enabled="false"').length - 1).toBe(1);
    expect(en.split('data-enabled="true"').length - 1).toBe(2);
    expect(en.split(`>${dict["skv.off"].en}<`).length - 1).toBe(1);
    expect(de.split(`>${dict["skv.off"].de}<`).length - 1).toBe(1);
  });

  it("shows the catalogue shelf with each row's installed state", () => {
    expect(en).toContain(">docx<");
    expect(en).toContain(dict["skv.notInstalled"].en);
    expect(de).toContain(dict["skv.notInstalled"].de);
    // The installed catalogue row says so rather than repeating the shelf word.
    expect(en).toContain(dict["skset.installed"].en);
  });
});

describe("the view is honest about what enablement means", () => {
  it("classifies skills in card 222's table, and the answer is next-session", () => {
    // Measured, not assumed: SkillLibrary.load runs inside
    // SessionConnection.buildAgentOnce — the catalogue rides the system prompt
    // and the use_skill tool is registered at the agent's build. A toggle
    // therefore reaches the NEXT session, never one already open.
    expect(reachOf(["skills"])).toBe("next-session");
  });

  it("renders the derived sentence, not a free-text promise", () => {
    expect(en).toContain('data-reach="next-session"');
    expect(en).toContain(dict["set.reachNextSession"].en);
    expect(de).toContain(dict["set.reachNextSession"].de);
    expect(en).not.toContain(dict["set.reachLive"].en);
  });
});

describe("the view looks, it does not switch", () => {
  it("offers exactly one button, and it is the door to the settings manager", () => {
    // The card's cut: card 224's plus menu is the fast switch, the settings
    // page holds the toggles, this is the place you go to LOOK. One button —
    // the manage door — and nothing that flips a skill from here.
    expect(en.split("<button").length - 1).toBe(1);
    expect(en).toContain(`type="button"`);
    expect(en).toContain(dict["skv.manage"].en);
    expect(de).toContain(dict["skv.manage"].de);
  });

  it("reads the one truth the settings page and the slash picker read", () => {
    // GET /api/skills is the enablement truth (the server's .disabled marker).
    // Exactly one fetch of it, and no write verb anywhere: a second copy of
    // the state, or a hidden toggle, is what this line is here to refuse.
    const source = readFileSync(fileURLToPath(new URL("./SkillsPane.tsx", import.meta.url)), "utf8");
    expect(source.split('fetch("/api/skills")').length - 1).toBe(1);
    expect(source).not.toContain("method:");
    expect(source).not.toContain("putSettings");
  });
});

describe("both languages carry every string the pane says", () => {
  it("has DE and EN for each key the view uses", () => {
    for (const key of [
      "nav.skills",
      "nav.skillsNote",
      "skv.claim",
      "skv.installedTitle",
      "skv.catalogueTitle",
      "skv.on",
      "skv.off",
      "skv.notInstalled",
      "skv.empty",
      "skv.manage",
    ]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de, `${key}.de`).toBeTruthy();
      expect(dict[key].en, `${key}.en`).toBeTruthy();
    }
  });
});

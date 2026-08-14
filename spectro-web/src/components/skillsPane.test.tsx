// The skills segment's surface. Card 225 built it as a read-only ledger; card
// 228 makes it the skills' ONE home — "in den Skills sollte man diese auch
// installieren können, und sie sollen aus den Einstellungen raus". The view
// now IS the manager: both roots listed, per-skill on/off, delete for
// user-root skills, and INSTALL from the shipped catalogue. The settings page
// keeps MCP servers and loses the skills section.
//
// What these tests pin is the MOVE, not a copy: one manager component
// (SkillsSettings), mounted by the pane and no longer by the settings page,
// still living in a *Settings.tsx file so the card-222 reach walker keeps
// walking its switches. Source-read pins, the settings walker's own idiom —
// the manager is a fetch container, so a static render shows only its
// loading line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reachOf } from "./settingsReach";
import { dict } from "../i18n/i18n";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const pane = read("./SkillsPane.tsx");
const manager = read("./SkillsMcpSettings.tsx");
const settingsPage = read("./SettingsPanel.tsx");
const plusMenu = read("./PlusMenuSettings.tsx");
const app = read("../App.tsx");

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

describe("the skills manager moved home (card 228)", () => {
  it("is mounted by the pane, exactly once", () => {
    expect(mounts(pane, "SkillsSettings")).toBe(1);
  });

  it("has LEFT the settings page, which keeps the MCP manager", () => {
    expect(mounts(settingsPage, "SkillsSettings")).toBe(0);
    expect(mounts(settingsPage, "McpSettings")).toBe(1);
  });

  it("keeps every capability the settings section had: toggle, delete, install", () => {
    // The .disabled marker toggle, the two-step delete, and the catalogue
    // install (state/skillInstall.ts owns its honesty rules). Losing any of
    // these in the move is criterion 4's "nothing silently loses a
    // capability".
    expect(manager).toContain("/disabled`");
    expect(manager).toContain('method: "DELETE"');
    expect(manager).toContain("installSkill(");
  });

  it("stays in a *Settings.tsx file, so the reach walker keeps its switches honest", () => {
    // settingsReach.test.tsx walks files matching /Settings(Panel)?\.tsx$/ —
    // a manager moved into SkillsPane.tsx itself would save settings outside
    // the walker's sight, which is review finding F10 all over again.
    expect(manager).toContain("export function SkillsSettings");
    expect(manager).toMatch(/<ReachBlock[^>]*fields=\{\["skills"\]\}/);
  });
});

describe("one truth, measured — never a second copy", () => {
  it("gives the pane no fetch of its own: the manager is the one reader", () => {
    expect(pane).not.toContain("fetch(");
  });

  it("has the plus menu and the manager read the same endpoint and write the same marker", () => {
    for (const src of [manager, plusMenu]) {
      expect(src).toContain('fetch("/api/skills")');
      expect(src).toContain("skillPath(");
      expect(src).toContain("/disabled`");
    }
  });
});

describe("the doors point at the place", () => {
  it("routes the plus menu's skills rows to the rail view, not the settings page", () => {
    // Card 224's Manage/Browse rows land on #/settings/skills[-catalogue];
    // since card 228 the App answers both by opening the skills segment.
    expect(app).toMatch(/section === "skills" \|\| section === "skills-catalogue"/);
    expect(app).toMatch(/setNav\("skills"\)/);
  });

  it("mounts the pane without a manage door — the view IS the manager", () => {
    expect(app).toMatch(/<SkillsPane \/>/);
    expect(pane).not.toContain("onManage");
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
});

describe("what install means is said, both halves", () => {
  it("names the folder road beside the catalogue — the install path that exists", () => {
    // The product's two install paths today: the catalogue copy
    // (POST /api/skills/install) and a SKILL.md folder dropped under a skills
    // root — the road the CLI's /skills line documents. A file-picker install
    // has NO server path yet; the card says so instead of the UI pretending.
    expect(dict["skv.installNote"]).toBeDefined();
    for (const lang of ["de", "en"] as const) {
      expect(dict["skv.installNote"][lang]).toContain("SKILL.md");
    }
  });

  it("keeps DE and EN for each key the pane says", () => {
    for (const key of ["nav.skills", "nav.skillsNote", "skv.claim", "skv.installNote"]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de, `${key}.de`).toBeTruthy();
      expect(dict[key].en, `${key}.en`).toBeTruthy();
    }
  });
});

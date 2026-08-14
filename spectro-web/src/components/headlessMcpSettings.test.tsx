// Card 220, the settings page's half of the owner's combined road: the mcp
// section grows the headlessMcp switch, and — card 222's machinery, not free
// text — a ReachBlock says WHICH run the switch touches. The reach vocabulary
// gains a fourth honest answer for it: "headless-run" is neither live nor
// next-session, because an interactive session never reads this key at all —
// it lands on the next headless start (spectro run per invocation, the cron
// daemon and a fleet node at theirs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReachBlock, SETTING_REACH, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("headlessMcp is classified before it is drawn", () => {
  it("sits in SETTING_REACH with the headless-run reach", () => {
    expect(SETTING_REACH.headlessMcp).toBe("headless-run");
    expect(reachOf(["headlessMcp"])).toBe("headless-run");
  });

  it("cannot share a sentence with the server list — they land at different moments", () => {
    // mcpServers is next-session (buildAgentOnce); the switch touches no web
    // session at all. One sentence about both would be card 222's own defect.
    expect(() => reachOf(["mcpServers", "headlessMcp"])).toThrow(/do not all reach/);
  });

  it("renders its own reach state into the DOM", () => {
    const html = renderToStaticMarkup(
      <ReachBlock lang="en" fields={["headlessMcp"]}>
        <span>switch</span>
      </ReachBlock>,
    );
    expect(html).toContain('data-reach="headless-run"');
    expect(html).toContain('data-reach-fields="headlessMcp"');
  });
});

describe("the sentence says which run the switch touches", () => {
  it("names the three headless faces and spares the interactive session, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const sentence = t(lang, "set.reachHeadless");
      expect(sentence, `set.reachHeadless must resolve for ${lang}`).not.toBe("set.reachHeadless");
      // The three faces that read it, by name — a reader must not have to
      // guess whether their cron job is covered.
      expect(sentence).toMatch(/spectro run/);
      expect(sentence).toMatch(/[Cc]ron/);
      expect(sentence).toMatch(/[Nn]ode/);
      // And the per-invocation override, so the flag half is discoverable here.
      expect(sentence).toMatch(/--mcp/);
    }
    // The EN wording states the boundary outright.
    expect(t("en", "set.reachHeadless")).toMatch(/interactive session/i);
  });

  it("is a distinct sentence, not a reuse of another reach's", () => {
    for (const lang of ["en", "de"] as const) {
      expect(t(lang, "set.reachHeadless")).not.toBe(t(lang, "set.reachLive"));
      expect(t(lang, "set.reachHeadless")).not.toBe(t(lang, "set.reachNextSession"));
    }
    expect(dict["set.reachHeadless"]).toBeDefined();
  });
});

describe("the mcp section carries the switch", () => {
  const skillsMcp = source("./SkillsMcpSettings.tsx");

  it("saves headlessMcp to the user scope", () => {
    expect(skillsMcp).toMatch(/putSettings\("user",\s*\{\s*headlessMcp/);
  });

  it("declares it in a ReachBlock of its own", () => {
    expect(skillsMcp).toMatch(/<ReachBlock[^>]*fields=\{\["headlessMcp"\]\}/);
  });

  it("labels it in both languages, permission-shaped", () => {
    for (const lang of ["en", "de"] as const) {
      const label = t(lang, "mcpset.headlessLabel");
      expect(label).not.toBe("mcpset.headlessLabel");
      const note = t(lang, "mcpset.headlessNote");
      expect(note).not.toBe("mcpset.headlessNote");
    }
    // The note carries the permission statement the spec required of the flag:
    // what auto approves once an unattended run mounts.
    expect(t("en", "mcpset.headlessNote")).toMatch(/every tool every configured server offers/);
    expect(t("en", "mcpset.headlessNote")).toMatch(/unwatched/);
  });
});

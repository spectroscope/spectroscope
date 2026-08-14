// The skills segment's surface — since card 228 the skills' ONE home (owner:
// "in den Skills sollte man diese auch installieren können, und sie sollen
// aus den Einstellungen raus"). You look, switch, install and remove in the
// same view; the settings page keeps the MCP servers and nothing else of
// this.
//
// The view mounts the MANAGER (SkillsSettings) rather than drawing a copy of
// its lists: one component, one `/api/skills` reader, and it stays in a
// *Settings.tsx file so the card-222 reach walker keeps walking its switches.
// Mounted per segment visit, so returning re-reads the roots — a switch
// flipped in the plus menu in between is on screen the next time this is.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { SkillsSettings } from "./SkillsMcpSettings";

export function SkillsPane() {
  const lang = useLang();
  return (
    <div className="skills-pane">
      <header className="skills-head">
        <div>
          <h2 className="skills-title">{t(lang, "nav.skills")}</h2>
          <p className="skills-claim">{t(lang, "skv.claim")}</p>
          {/* The install roads, both said: the catalogue button below is one,
              a SKILL.md folder under a skills root is the other — the manual
              road the CLI documents. A file-picker install has no server path
              yet (card 228 records that half as new). */}
          <p className="skills-claim skills-install-note">{t(lang, "skv.installNote")}</p>
        </div>
      </header>
      <SkillsSettings headed={false} />
    </div>
  );
}

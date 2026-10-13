// The skills view, since card 228 the skills' ONE home (owner:
// "in den Skills sollte man diese auch installieren können, und sie sollen
// aus den Einstellungen raus"). You look, switch, install and remove in the
// same view; the settings page keeps the MCP servers and nothing else of
// this.
//
// The view mounts the MANAGER (SkillsSettings) rather than drawing a copy of
// its lists: one component, one `/api/skills` reader, and it stays in a
// *Settings.tsx file so the card-222 reach walker keeps walking its switches.
// Mounted each time the view opens, so returning re-reads the roots: a
// switch flipped in the plus menu in between is on screen the next time this
// is. Since card 409 the view is opened from the rail's upper group and the
// session list stays beside it; its claim carries what the rail's note said.
// Card 554: the view is "Skills and Commands" and lists the chat commands
// below the skills (ChatCommandsSection).
// Card 558: between the two, "This session" lists the items the session in
// view reads (SessionItemsSection), read only.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { SkillsSettings } from "./SkillsMcpSettings";
import { ChatCommandsSection } from "./ChatCommandsSection";
import { SessionItemsSection } from "./SessionItemsSection";
import type { SessionItems } from "../state/sessionItems";

export function SkillsPane({
  sessionItems = null,
  onAskSessionItems,
}: {
  /** Card 558: the session in view's items, or null while it has sent none. */
  sessionItems?: SessionItems | null;
  /** Card 558: asks the session in view for its items. */
  onAskSessionItems?: () => void;
} = {}) {
  const lang = useLang();
  return (
    <div className="skills-pane">
      {/* Card 411: one column at the settings page's width, from the left. */}
      <div className="skills-column">
        <header className="skills-head">
          <div>
            <h2 className="skills-title">{t(lang, "nav.skills")}</h2>
            <p className="skills-claim">{t(lang, "skv.claim")}</p>
            {/* The install roads, both said: the catalogue button below is one,
                a SKILL.md folder under a skills root is the other, the manual
                road the CLI documents. A file-picker install has no server path
                yet (card 228 records that half as new). */}
            <p className="skills-claim skills-install-note">{t(lang, "skv.installNote")}</p>
          </div>
        </header>
        <SkillsSettings headed={false} />
        {/* Card 558: what the session in view reads, by kind and source. */}
        <SessionItemsSection items={sessionItems} onAsk={onAskSessionItems} />
        {/* Card 554 (owner answer 6): the chat commands from the shared list. */}
        <ChatCommandsSection />
      </div>
    </div>
  );
}

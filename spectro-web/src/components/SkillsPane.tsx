// The skills segment's surface (card 225, owner wish: "die Skills links in
// eine Leiste"). The rail's fifth nav row opens this view — the place you go
// to LOOK at what the product can do: the namespaced catalogue and everything
// installed, each with its name, one-line description, enabled state and its
// namespace in plain sight.
//
// ONE truth, never a second copy: everything drawn here is the answer of
// GET /api/skills — the endpoint the settings manager reads, the composer's
// slash picker reads (state/skillList.ts), and card 224's plus menu reads on
// its branch. Enablement is the server's own .disabled marker; this component
// holds no state beyond the fetched answer and writes nothing.
//
// Read-only by design. The card's cut: card 224's plus menu is the fast
// switch, the settings page holds the toggles, this view is the ledger. Its
// one action is the door to the manager — so a reader who came to look and
// decided to switch is one press from the control, instead of hunting for a
// second copy of it here.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { CatalogueRow } from "../state/skillInstall";
import { ReachBlock } from "./settingsReach";

/** One installed skill as /api/skills lists it — the settings manager's own
 *  row shape (SkillsController scans both roots, disabled ones included). */
export interface SkillsViewRow {
  /** As the agent calls it: `<pack>:<skill>` for a catalogue install, bare otherwise. */
  name: string;
  /** The skill's own folder — the display name is not a path. */
  folder: string;
  /** The pack folder — the namespace. Null for a top-level install. */
  pack: string | null;
  description: string;
  /** Which root carries it: `~/.spectro/skills` or the project's. */
  source: "user" | "project";
  /** The .disabled marker — the loader hides such a skill, this view must not. */
  disabled: boolean;
}

interface Answer {
  skills: SkillsViewRow[];
  catalogue: CatalogueRow[];
}

/**
 * The container: fetches once per mount and hands the pure surface the answer.
 * A segment switch unmounts this arm (like the state graph's), so returning to
 * the segment re-reads the roots — a toggle made on the settings page in
 * between is on screen the next time this view is.
 */
export function SkillsPane(props: { onManage: () => void }) {
  const lang = useLang();
  const [answer, setAnswer] = useState<Answer | null | "failed">(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: unknown) => {
        if (!alive) return;
        const res = body as { skills?: SkillsViewRow[]; catalogue?: CatalogueRow[] };
        // A build without the catalogue resource answers without the field —
        // an empty shelf, not a failure (the settings manager reads it the
        // same way).
        setAnswer({ skills: res.skills ?? [], catalogue: res.catalogue ?? [] });
      })
      .catch(() => {
        if (alive) setAnswer("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (answer === "failed") {
    return (
      <div className="skills-pane">
        <p className="settings-note">{t(lang, "doc.unreachable")}</p>
      </div>
    );
  }
  if (answer === null) {
    return (
      <div className="skills-pane">
        <p className="settings-note">…</p>
      </div>
    );
  }
  return (
    <SkillsSurface lang={lang} skills={answer.skills} catalogue={answer.catalogue} onManage={props.onManage} />
  );
}

/**
 * The surface itself, pure — skillsPane.test.tsx renders THIS with fixtures
 * (the container's fetch is invisible to a static render; the test pins it by
 * reading the source, the settings walker's idiom).
 */
export function SkillsSurface(props: {
  lang: Lang;
  skills: SkillsViewRow[];
  catalogue: CatalogueRow[];
  onManage: () => void;
}) {
  const { lang, skills, catalogue } = props;
  return (
    <div className="skills-pane">
      <header className="skills-head">
        <div>
          <h2 className="skills-title">{t(lang, "nav.skills")}</h2>
          <p className="skills-claim">{t(lang, "skv.claim")}</p>
        </div>
        {/* The one control, and it is a door: switching lives on the settings
            page (card 224's menu will be the fast path in the composer). */}
        <button type="button" className="ghost skills-manage" onClick={props.onManage}>
          {t(lang, "skv.manage")}
        </button>
      </header>

      <section className="skills-section" aria-label={t(lang, "skv.installedTitle")}>
        <p className="sidebar-eyebrow skills-eyebrow">{t(lang, "skv.installedTitle")}</p>
        {/* Card 222's machinery, not free text: `skills` is classified in
            SETTING_REACH (measured — SkillLibrary.load runs inside
            buildAgentOnce), and the sentence under this list is derived from
            that table. */}
        <ReachBlock lang={lang} fields={["skills"]}>
          {skills.length === 0 ? (
            <p className="settings-note">{t(lang, "skv.empty")}</p>
          ) : (
            <ul className="skills-list">
              {skills.map((row) => (
                <li key={`${row.source}:${row.name}`} className="skills-row" data-enabled={!row.disabled}>
                  <span
                    className={`skills-state${row.disabled ? "" : " skills-state--on"}`}
                    aria-hidden="true"
                  />
                  <span className="skills-state-word">{t(lang, row.disabled ? "skv.off" : "skv.on")}</span>
                  <span className="skills-name mono">{row.name}</span>
                  {/* The namespace as a tag of its own, not only inside the
                      colon name; a bare skill wears no pack, its root still
                      says where it lives. */}
                  {row.pack !== null && <span className="wsg-scope-tag">{row.pack}</span>}
                  <span className="wsg-scope-tag">{row.source}</span>
                  <span className="skills-desc" title={row.description}>
                    {row.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ReachBlock>
      </section>

      {catalogue.length > 0 && (
        <section className="skills-section" aria-label={t(lang, "skv.catalogueTitle")}>
          <p className="sidebar-eyebrow skills-eyebrow">{t(lang, "skv.catalogueTitle")}</p>
          <p className="settings-note">{t(lang, "skset.catalogueNote")}</p>
          <ul className="skills-list">
            {catalogue.map((row) => (
              <li key={row.id} className="skills-row" data-installed={row.installed}>
                <span className="skills-name mono">{row.name}</span>
                <span className="wsg-scope-tag">{row.pack}</span>
                <span className="skills-desc" title={row.description}>
                  {row.description}
                </span>
                <span className={`skills-shelf-state${row.installed ? " skills-shelf-state--in" : ""}`}>
                  {t(lang, row.installed ? "skset.installed" : "skv.notInstalled")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Step 2 of the Spectrolyzr wizard (card 484): the add-ons, and with the
// playbook add-on the folder the playbook goes into, a sibling of the project
// folder unless the owner types or chooses another (Choose, card 512).

import { t } from "../../i18n/i18n";
import { chooseFolder, usePickNote } from "../../state/folderPick";
import { useLang } from "../../state/lang";
import { choose, useLyzr } from "../../state/spectrolyzr";
import { effectivePlaybookDir, PLAYBOOK_ADDON } from "./folders";
import { FieldError, mark, type Invalid } from "./StepProject";

/** The add-ons and the playbook folder. */
export function StepAddons({ invalid }: { invalid: Invalid }) {
  const lang = useLang();
  const { catalog, choices } = useLyzr();
  const pickNote = usePickNote("lyzrPlaybook");
  if (catalog === null) return <p className="lyzr-hint">{t(lang, "lyzr.loading")}</p>;
  const playbookOn = choices.addons.includes(PLAYBOOK_ADDON);

  return (
    <div className="lyzr-step">
      <h3 className="lyzr-h">{t(lang, "lyzr.step.addons")}</h3>
      <div className={`lyzr-addons${mark(invalid, "addons")}`}>
        {catalog.addons.map((a) => {
          const on = choices.addons.includes(a.id);
          return (
            <label key={a.id} className="lyzr-addon-row">
              <input
                type="checkbox"
                className="lyzr-addon"
                checked={on}
                onChange={() =>
                  choose({
                    addons: on ? choices.addons.filter((x) => x !== a.id) : [...choices.addons, a.id],
                  })
                }
              />
              <span className="lyzr-addon-text">
                <span className="lyzr-addon-name">{a.name[lang]}</span>
                <span className="lyzr-addon-line">{a.description[lang]}</span>
              </span>
            </label>
          );
        })}
      </div>
      <FieldError invalid={invalid} field="addons" />

      {playbookOn && (
        <>
          <div className="lyzr-target">
            <label className="lyzr-field">
              <span className="lyzr-label">{t(lang, "lyzr.playbookDir")}</span>
              <input
                className={`lyzr-playbook-dir lyzr-input${mark(invalid, "playbookDir")}`}
                type="text"
                value={effectivePlaybookDir(choices)}
                placeholder={t(lang, "lyzr.typePath")}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => choose({ playbookDir: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="lyzr-choose"
              onClick={() => void chooseFolder("lyzrPlaybook", (path) => choose({ playbookDir: path }))}
            >
              {t(lang, "pick.choose")}
            </button>
          </div>
          {pickNote !== null && (
            <p className="lyzr-hint" role="status">
              {pickNote}
            </p>
          )}
          <p className="lyzr-hint">{t(lang, "lyzr.playbookDirHint")}</p>
          <FieldError invalid={invalid} field="playbookDir" />
        </>
      )}
    </div>
  );
}

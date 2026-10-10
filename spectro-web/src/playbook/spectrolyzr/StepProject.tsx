// Step 1 of the Spectrolyzr wizard (card 484): the archetype, the language and
// the project name, with the name rule under the field.

import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import { choose, nameUsable, useLyzr } from "../../state/spectrolyzr";

/** The field a 400 answer named, and the server's words for it. */
export type Invalid = { field: string; message: string } | null;

/** The class suffix that marks a field the last answer refused. */
export function mark(invalid: Invalid, field: string): string {
  return invalid !== null && invalid.field === field ? " is-invalid" : "";
}

/** The error line under a refused field, or nothing. */
export function FieldError({ invalid, field }: { invalid: Invalid; field: string }) {
  if (invalid === null || invalid.field !== field) return null;
  return (
    <p className="lyzr-error" role="alert">
      {invalid.message}
    </p>
  );
}

/** Archetype, language and name. */
export function StepProject({ invalid }: { invalid: Invalid }) {
  const lang = useLang();
  const { catalog, choices } = useLyzr();
  if (catalog === null) return <p className="lyzr-hint">{t(lang, "lyzr.loading")}</p>;
  const nameBad = choices.name !== "" && !nameUsable(choices.name);

  return (
    <div className="lyzr-step">
      <h3 className="lyzr-h">{t(lang, "lyzr.archetype")}</h3>
      <div className={`lyzr-cards${mark(invalid, "archetype")}`}>
        {catalog.archetypes.map((a) => {
          const on = choices.archetype === a.id;
          return (
            <button
              key={a.id}
              type="button"
              className={`lyzr-card${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => choose({ archetype: a.id })}
            >
              <span className="lyzr-card-name">{a.name[lang]}</span>
              <span className="lyzr-card-line">{a.description[lang]}</span>
            </button>
          );
        })}
      </div>
      <FieldError invalid={invalid} field="archetype" />

      <h3 className="lyzr-h">{t(lang, "lyzr.language")}</h3>
      <div
        className={`lyzr-langs${mark(invalid, "language")}`}
        role="group"
        aria-label={t(lang, "lyzr.language")}
      >
        {catalog.languages.map((l) => {
          const on = choices.language === l.id;
          return (
            <button
              key={l.id}
              type="button"
              className={`lyzr-lang${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => choose({ language: l.id })}
            >
              {l.name}
            </button>
          );
        })}
      </div>
      <FieldError invalid={invalid} field="language" />

      <label className="lyzr-field">
        <span className="lyzr-label">{t(lang, "lyzr.name")}</span>
        <input
          className={`lyzr-name lyzr-input${nameBad ? " is-invalid" : mark(invalid, "name")}`}
          type="text"
          value={choices.name}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => choose({ name: e.target.value })}
        />
      </label>
      <p className="lyzr-hint">{t(lang, "lyzr.nameRule")}</p>
      <FieldError invalid={invalid} field="name" />
    </div>
  );
}

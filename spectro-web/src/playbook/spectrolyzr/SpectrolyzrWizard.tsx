// The Spectrolyzr wizard (card 484). A view of the playbook segment in a chunk
// of its own: learn and light never open that segment, so they never request
// this file. Three steps on one rail, Back and Next on every step: the
// project, the add-ons, the review. The choices live in state/spectrolyzr.ts,
// so a switch of segment keeps them. The stylesheet is styles/spectrolyzr.css,
// imported by app.css: a surface chunk carries no stylesheet of its own.

import { useEffect, useState } from "react";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import {
  choose,
  generate,
  goTo,
  loadCatalog,
  nameUsable,
  useLyzr,
  type LyzrChoices,
} from "../../state/spectrolyzr";
import { effectivePlaybookDir, PLAYBOOK_ADDON } from "./folders";
import { StepAddons } from "./StepAddons";
import { StepProject } from "./StepProject";
import { StepReview } from "./StepReview";

type Step = 1 | 2 | 3;

const STEPS: { step: Step; label: string }[] = [
  { step: 1, label: "lyzr.step.project" },
  { step: 2, label: "lyzr.step.addons" },
  { step: 3, label: "lyzr.step.review" },
];

/** Whether the choices let the owner leave a step forward. */
export function canAdvance(step: Step, c: LyzrChoices): boolean {
  if (step === 1) return c.archetype !== null && c.language !== null && nameUsable(c.name);
  return step === 2;
}

/** The step that owns a field a 400 answer named. */
function stepOf(field: string): Step {
  if (field === "archetype" || field === "language" || field === "name") return 1;
  if (field === "addons" || field === "playbookDir") return 2;
  return 3;
}

/** The wizard that generates a project and its playbook. */
export function SpectrolyzrWizard() {
  const lang = useLang();
  const s = useLyzr();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (s.catalog !== null) return;
    loadCatalog().catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [s.catalog]);

  const invalid = s.result?.kind === "invalid" ? { field: s.result.field, message: s.result.message } : null;
  const reachable = (step: Step): boolean => step === 1 || (canAdvance(1, s.choices) && step <= 3);

  const run = async (): Promise<void> => {
    const c = s.choices;
    if (c.addons.includes(PLAYBOOK_ADDON) && c.playbookDir === "")
      choose({ playbookDir: effectivePlaybookDir(c) });
    setBusy(true);
    try {
      const result = await generate();
      if (result.kind === "invalid") {
        const owner = stepOf(result.field);
        if (owner !== 3) goTo(owner);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lyzr" aria-label={t(lang, "lyzr.title")}>
      <h2 className="lyzr-title">{t(lang, "lyzr.title")}</h2>
      <ol className="lyzr-rail">
        {STEPS.map(({ step, label }) => (
          <li key={step}>
            <button
              type="button"
              className={`lyzr-rail-step${s.step === step ? " is-current" : ""}`}
              aria-current={s.step === step ? "step" : undefined}
              disabled={!reachable(step)}
              onClick={() => goTo(step)}
            >
              <span className="lyzr-rail-n">{step}</span>
              {t(lang, label)}
            </button>
          </li>
        ))}
      </ol>
      {notice !== null && (
        <p className="lyzr-error" role="alert">
          {notice}
        </p>
      )}

      {s.step === 1 ? (
        <StepProject invalid={invalid} />
      ) : s.step === 2 ? (
        <StepAddons invalid={invalid} />
      ) : (
        <StepReview invalid={invalid} busy={busy} onGenerate={() => void run()} />
      )}

      <nav className="lyzr-nav" aria-label={t(lang, "lyzr.title")}>
        <button
          type="button"
          className="lyzr-back"
          disabled={s.step === 1}
          onClick={() => goTo((s.step - 1) as Step)}
        >
          {t(lang, "lyzr.back")}
        </button>
        {s.step < 3 && (
          <button
            type="button"
            className="lyzr-next"
            disabled={!canAdvance(s.step, s.choices)}
            onClick={() => goTo((s.step + 1) as Step)}
          >
            {t(lang, "lyzr.next")}
          </button>
        )}
      </nav>
    </section>
  );
}

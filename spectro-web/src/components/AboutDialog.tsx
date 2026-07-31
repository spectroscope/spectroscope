// The About panel: the mark, the version, and the licence terms in full.
//
// It rises from the bottom-right corner rather than centring, because the
// footer entry that opens it sits there — the panel appears where the pointer
// already is, and the corner it occupies is the one corner of the shell that
// carries no permanent control.
//
// The version is fetched, never compiled in. /api/bundles is the one reachable
// endpoint that reports the server's release (StarterBundles.VERSION); the
// bundle's own package.json is stale and would be a confident wrong answer.
// A failed fetch shows no version at all.
//
// Every licence sentence comes from ABOUT, which about.drift.test.ts pins to
// LICENSE and LICENSE-ASSETS.md. Editing the terms here without editing the
// licence there fails the gate, which is the point.

import { useEffect, useState } from "react";
import { ABOUT, releaseVersion } from "./about";
import { CopyButton } from "./CopyButton";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function AboutDialog(props: { onClose: () => void }) {
  const lang = useLang();
  const [version, setVersion] = useState<string | null>(null);
  const { onClose } = props;

  // The server's number or none. A late reply after close must not land.
  useEffect(() => {
    let live = true;
    fetch("/api/bundles")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (live) setVersion(releaseVersion(c?.version));
      })
      .catch(() => {
        /* offline or an older server: the panel simply shows no version */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="about-backdrop" role="presentation" onClick={onClose}>
      <div
        className="about-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-head">
          <div className="about-ident">
            {/* The M1 line bundle, geometry shared with the sidebar mark so the
                bars read the active theme's spectral tokens. */}
            <svg className="about-mark" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
              <rect x="13.2" y="14" width="2.6" height="36" rx="0.7" fill="var(--sp-red)" />
              <rect x="21.7" y="14" width="1.6" height="36" rx="0.7" fill="var(--sp-amber)" />
              <rect x="28.9" y="14" width="5.2" height="36" rx="0.7" fill="var(--sp-teal)" />
              <rect x="42" y="14" width="2" height="36" rx="0.7" fill="var(--sp-ocean)" />
              <rect x="49.35" y="14" width="1.3" height="36" rx="0.7" fill="var(--text-faint)" />
            </svg>
            <div className="about-names">
              <h2 id="about-title" className="about-name">
                spectroscope
                {version !== null && <span className="about-version mono"> v{version}</span>}
              </h2>
              <span className="about-tagline">{t(lang, "about.tagline")}</span>
            </div>
          </div>
          <button
            type="button"
            className="about-close"
            aria-label={t(lang, "common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="about-section">
          <div className="about-section-head">{t(lang, "about.licences")}</div>

          <dl className="about-terms">
            <dt>
              <a href={ABOUT.codeLicenceUrl} target="_blank" rel="noreferrer noopener">
                {t(lang, "about.codeLabel")} · MIT
              </a>
            </dt>
            <dd>{t(lang, "about.code")}</dd>

            <dt>
              <a href={ABOUT.ccByUrl} target="_blank" rel="noreferrer noopener">
                {t(lang, "about.imagesLabel")} · CC BY 4.0
              </a>
            </dt>
            <dd>
              {t(lang, "about.images")}
              {/* All three, because CC BY 4.0 section 3(a)(1)(B) makes marking a
                  change a condition. Naming only credit would grant adaptation
                  on lighter terms than the licence this row links to. */}
              <ul className="about-conditions">
                {ABOUT.ccByConditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="about-attrib-label">{t(lang, "about.attributionLabel")}</div>
              <div className="about-attrib">
                <code className="mono">{ABOUT.attribution}</code>
                <CopyButton text={() => ABOUT.attribution} />
              </div>
              {/* The sentence that makes the credit a term and not a courtesy. */}
              <p className="about-condition">{t(lang, "about.attributionCondition")}</p>
            </dd>

            <dt>
              <a href={ABOUT.assetsLicenceUrl} target="_blank" rel="noreferrer noopener">
                {t(lang, "about.marksLabel")}
              </a>
            </dt>
            <dd>
              {t(lang, "about.marks")}
              {/* The carve-out reaches inside the images granted above: a guide
                  screenshot is CC BY and carries the wordmark in its sidebar. */}
              <p className="about-condition">{ABOUT.marksWhereverTheyAppear}</p>
            </dd>

            <dt>{t(lang, "about.fontsLabel")}</dt>
            <dd>
              {/* Not ours to summarise away: a project may waive its own rights
                  and not a third party's terms. NOTICE.md carries the full text. */}
              <ul className="about-conditions">
                {ABOUT.fonts.map((f) => (
                  <li key={f.name}>
                    <a href={f.url} target="_blank" rel="noreferrer noopener">
                      {f.name}
                    </a>
                    {` — ${f.holder}, ${ABOUT.fontsLicence}`}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </div>

        <div className="about-foot">
          <a className="about-repo" href={ABOUT.repo} target="_blank" rel="noreferrer noopener">
            {t(lang, "about.repo")}
          </a>
          <span className="about-copyright">
            {/* The name links to the person, not to another copy of the licence:
                the copyright line names an author and an author is reachable. */}
            {ABOUT.copyright.split(ABOUT.author)[0]}
            <a href={ABOUT.authorUrl} target="_blank" rel="noreferrer noopener">
              {ABOUT.author}
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

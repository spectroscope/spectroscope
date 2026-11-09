// Card 604: the consent sheet of the files tab's model reading, in the style of
// card 294's sheet (components/AnalyzeRun.tsx) and with its classes. Before
// anything is sent it names the provider, the model and the address, says
// whether the address is on this machine, counts the characters and shows the
// whole text. The send button waits for the server's pre-flight. Pure, so a
// test can pin every promise without a DOM.

import type { JSX, KeyboardEvent } from "react";
import "../components/analyzeRun.css";
import { t, type Lang } from "../i18n/i18n";
import { isLoopbackAddress } from "../state/runDigest";
import type { AnalyzeEngineReport } from "../state/runAnalysis";
import { FILES_DIGEST_MAX, OUTPUT_MAX } from "./digest";
import type { FilesConsentState } from "./filesAnalysis";

export interface FilesConsentProps {
  lang: Lang;
  consent: FilesConsentState;
  /** A reading of this session is streaming. */
  running: boolean;
  onRun: () => void;
  onClose: () => void;
}

/** Why the pair cannot run, from the pre-flight's reason. */
function outKey(report: AnalyzeEngineReport): string {
  switch (report.reason) {
    case "missing-pair":
      return "filesTab.consent.out.missingPair";
    case "builtin-model":
      return "filesTab.consent.out.builtin";
    case "needs-key":
      return "filesTab.consent.out.needsKey";
    default:
      return "filesTab.consent.out.generic";
  }
}

export function FilesConsent(props: FilesConsentProps): JSX.Element {
  const { lang, consent } = props;
  const { report, digest } = consent;
  const provider = report?.provider ?? consent.pick.provider;
  const model = report?.model ?? consent.pick.model;
  const address = report?.address;
  const number = (n: number): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The tab's arrow keys step through calls; inside the sheet they belong to the sheet.
    e.stopPropagation();
    if (e.key === "Escape") props.onClose();
  };
  return (
    <div className="km-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="km-panel ob-panel files-consent"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "filesTab.consent.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="km-head">
          <span className="km-title">{t(lang, "filesTab.consent.title")}</span>
          <button
            type="button"
            className="km-close"
            data-action="consent-close"
            onClick={props.onClose}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>
        <p className="ob-intro">{t(lang, "filesTab.consent.lede")}</p>
        <ul className="ob-opts">
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">{provider}</span>
              <span className="ob-opt-title">{t(lang, "filesTab.consent.model")}</span>
              <span className="ob-opt-tag mono">{model}</span>
            </div>
            {address !== undefined && (
              <>
                <p className="ob-opt-body">
                  {t(lang, "filesTab.consent.address")}: <span className="mono">{address}</span>
                </p>
                <p className="ob-opt-body">
                  {t(lang, isLoopbackAddress(address) ? "filesTab.consent.local" : "filesTab.consent.remote")}
                </p>
              </>
            )}
            {report === null && consent.error === null && (
              <p className="ob-opt-body">{t(lang, "filesTab.consent.asking")}</p>
            )}
            {report !== null && !report.available && (
              <p className="ob-opt-body">
                {t(lang, outKey(report))}
                {report.detail !== undefined && ` ${report.detail}`}
              </p>
            )}
            {consent.error !== null && (
              <p className="ob-opt-body">{t(lang, "filesTab.consent.askFailed", { msg: consent.error })}</p>
            )}
          </li>
        </ul>
        <p className="ob-foot-note">
          {t(lang, digest.calls === 1 ? "filesTab.consent.planOne" : "filesTab.consent.plan", {
            c: number(digest.text.length),
            n: digest.calls,
            out: number(OUTPUT_MAX),
          })}
          {digest.truncated && ` ${t(lang, "filesTab.consent.cut", { max: number(FILES_DIGEST_MAX) })}`}
        </p>
        <details className="an-digest">
          <summary className="ob-foot-note">{t(lang, "filesTab.consent.show")}</summary>
          <pre className="an-digest-text mono">{digest.text}</pre>
        </details>
        <div className="ob-foot">
          <button type="button" className="ghost" data-action="consent-cancel" onClick={props.onClose}>
            {t(lang, "filesTab.consent.cancel")}
          </button>
          <button
            type="button"
            className="soft-primary"
            data-action="consent-run"
            disabled={report?.available !== true || props.running}
            onClick={props.onRun}
          >
            {t(lang, "filesTab.consent.send", { model })}
          </button>
        </div>
      </div>
    </div>
  );
}

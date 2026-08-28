// The "analyze this run" affordance (card 294): a button on the imported-run
// surfaces (the lab's workflow lens, the agents panel), a consent sheet, and
// the result block. The consent step shows BEFORE anything is sent: the
// provider, the model, the address, and the digest itself — the exact text
// that leaves. A loopback address adds the stays-on-this-machine line.
//
// Nothing runs at import time. The only fetches behind this file live in
// state/runAnalysis.ts: the engine pre-flight (fired when the sheet opens, so
// no button can fail) and the analysis itself (fired by the consent click).
//
// The result is labelled as the MODEL'S READING, never a measurement — the
// product's honesty line extends to this feature. A model that answers prose
// instead of the asked JSON renders as prose; a server error renders verbatim.
// The result lives in app state only; re-analyzing is another click.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import type { Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildRunDigest, isLoopbackAddress } from "../state/runDigest";
import type { RunDigest } from "../state/runDigest";
import {
  fetchAnalyzeEngine,
  readAnalysis,
  resetAnalysis,
  startAnalysis,
  useAnalysis,
} from "../state/runAnalysis";
import type { AnalysisState, AnalyzeEngineReport } from "../state/runAnalysis";
import "./analyzeRun.css";

/** The i18n key explaining why the engine is out, or null when it can run. */
export function reasonKey(report: AnalyzeEngineReport): string | null {
  if (report.available) return null;
  switch (report.reason) {
    case "needs-key":
      return "an.out.needsKey";
    case "provider-is-local":
      return "an.out.providerIsLocal";
    default:
      return "an.out.generic";
  }
}

/**
 * The consent step — pure, so the gate can pin its promises without a DOM.
 * Everything the click will spend is named here: provider, model, address,
 * and the digest itself, inspectable in full.
 */
export function AnalyzeConsent(props: {
  lang: Lang;
  /** The server's pre-flight, or null while it is still being asked. */
  report: AnalyzeEngineReport | null;
  /** A pre-flight that could not be made — shown instead of a guess. */
  reportError: string | null;
  digest: RunDigest;
  running: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  const { lang, report, digest } = props;
  const loopback = report?.address !== undefined && isLoopbackAddress(report.address);
  const why = report === null ? null : reasonKey(report);
  return (
    <div className="km-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="km-panel ob-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "an.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="km-head">
          <span className="km-title">{t(lang, "an.title")}</span>
          <button
            type="button"
            className="km-close"
            onClick={props.onClose}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>

        {/* The opt-in contract, before anything else. */}
        <p className="ob-intro">{t(lang, "an.lede")}</p>

        <ul className="ob-opts">
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">{report?.provider ?? "…"}</span>
              <span className="ob-opt-title">{t(lang, "an.engine")}</span>
              {report?.model !== undefined && <span className="ob-opt-tag mono">{report.model}</span>}
            </div>
            {report?.address !== undefined && (
              <p className="ob-opt-body">
                {t(lang, "an.address")}: <span className="mono">{report.address}</span>
              </p>
            )}
            {/* The data-movement sentence: whose key, and where the text goes.
                A loopback address earns the stays-local line instead. */}
            <p className="ob-opt-body">{t(lang, loopback ? "an.engine.localBody" : "an.engine.body")}</p>
            {why !== null && (
              <p className="ob-opt-body">
                {t(lang, why)}
                {report?.detail !== undefined && ` — ${report.detail}`}
              </p>
            )}
          </li>
        </ul>

        {props.reportError !== null && (
          <p className="ob-opt-body">{t(lang, "an.enginesFailed", { msg: props.reportError })}</p>
        )}

        {/* What leaves, stated in numbers and inspectable in full. */}
        <p className="ob-foot-note">
          {t(lang, "an.plan", { c: digest.text.length, a: digest.agents })}
          {digest.truncated && ` ${t(lang, "an.planCapped")}`}
        </p>
        <details className="an-digest">
          <summary className="ob-foot-note">{t(lang, "an.showDigest")}</summary>
          <pre className="an-digest-text mono">{digest.text}</pre>
        </details>

        <div className="ob-foot">
          <span />
          <button
            type="button"
            className="soft-primary"
            disabled={report?.available !== true || props.running}
            onClick={props.onRun}
          >
            {t(lang, "an.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The result block — pure, so the gate can pin the label, the lenient prose
 * fallback and the error path without a DOM. Idle renders nothing at all.
 */
export function AnalyzeResult(props: {
  lang: Lang;
  state: AnalysisState;
  onAgain: () => void;
  onDiscard: () => void;
}) {
  const { lang, state } = props;
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return <p className="an-result an-running">{t(lang, "an.running")}</p>;
  }
  if (state.status === "error") {
    return (
      <div className="an-result an-error">
        <p>{t(lang, "an.failed", { msg: state.error ?? "?" })}</p>
        <button type="button" className="ghost" onClick={props.onAgain}>
          {t(lang, "an.again")}
        </button>
      </div>
    );
  }
  // done: the structured shape when the model kept to it, prose otherwise —
  // both honestly labelled as a reading, never a measurement.
  const reading = readAnalysis(state.text);
  return (
    <div className="an-result">
      <div className="an-label">
        <span className="an-label-words">{t(lang, "an.readingLabel")}</span>
        {state.meta !== null && (
          <span className="an-meta mono">
            {state.meta.provider} · {state.meta.model} · {state.meta.address}
          </span>
        )}
      </div>
      {reading === null ? (
        <pre className="an-prose">{state.text}</pre>
      ) : (
        <>
          <p className="an-summary">{reading.summary}</p>
          {reading.agents.length > 0 && (
            <ul className="an-agents">
              {reading.agents.map((agent) => (
                <li key={agent.id}>
                  <span className="mono an-agent-id">{agent.id}</span> {agent.reading}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="an-result-foot">
        <button type="button" className="ghost" onClick={props.onAgain}>
          {t(lang, "an.again")}
        </button>
        <button type="button" className="ghost" onClick={props.onDiscard}>
          {t(lang, "an.discard")}
        </button>
      </div>
    </div>
  );
}

/**
 * The whole affordance: button → consent sheet → result. Mounted on the
 * imported-run surfaces (lab workflow lens, agents panel); both share one
 * store entry per viewKey, so the reading appears on both at once.
 */
export function AnalyzeRun(props: { viewKey: string; events: readonly RunEvent[] }) {
  const lang = useLang();
  const state = useAnalysis(props.viewKey);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<AnalyzeEngineReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  // Built locally and deterministically — building it moves nothing anywhere.
  const digest = useMemo(() => buildRunDigest(props.events), [props.events]);

  const openSheet = (): void => {
    setOpen(true);
    setReport(null);
    setReportError(null);
    // The pre-flight, so the sheet shows what the SERVER would resolve and no
    // run button can fail. This is the affordance click, not the consent one:
    // it asks what a call WOULD use and sends nothing of the run.
    fetchAnalyzeEngine().then(setReport, (failed: unknown) => {
      setReportError(failed instanceof Error ? failed.message : String(failed));
    });
  };

  const run = (): void => {
    setOpen(false);
    void startAnalysis(props.viewKey, digest.text, lang);
  };

  return (
    <div className="an-block">
      <div className="an-bar">
        <button
          type="button"
          className="trace-lens mono"
          title={t(lang, "an.buttonTitle")}
          onClick={openSheet}
        >
          {t(lang, "an.button")}
        </button>
      </div>
      <AnalyzeResult
        lang={lang}
        state={state}
        onAgain={openSheet}
        onDiscard={() => resetAnalysis(props.viewKey)}
      />
      {open &&
        createPortal(
          <AnalyzeConsent
            lang={lang}
            report={report}
            reportError={reportError}
            digest={digest}
            running={state.status === "running"}
            onRun={run}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

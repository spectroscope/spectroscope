// The replay surface (card 204): a scrubber over a finished session's browser
// trace.
//
// WHY THIS EXISTS AT ALL. The product's category is "the agent orchestrator you
// can watch", and card 201 gave the agent a real browser that an operator can
// watch LIVE. Live is half a promise: a run that leaves no record can only be
// observed while it happens, and the surface that is hardest to reason about
// afterwards — a page the agent clicked through — was the one surface you could
// only ever witness once.
//
// WHAT IT LOADS, AND NOTHING ELSE. The sidecar's ledger
// (GET /api/sessions/{id}/browser-wire/index) and, for the step a reader opens,
// its two recorded lines. Pictures come from the image store by their recorded
// hash. There is no live socket here, no WebContentsView and no page: a replay
// of a finished run must not be able to start a browser, and this file has no
// way to.
//
// WHY THE BROWSER PICKER IS NOT DECORATION. A session can outlive its browser —
// closing the session retires it and a resume opens a fresh one with fresh
// cookies (card 218) — and both append to the same sidecar. Scrubbing straight
// through would show a logged-in page becoming a logged-out one for no visible
// reason. So epochs are separate stories and the reader picks one.

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  browserStepSummary,
  fetchBrowserAction,
  fetchBrowserWireIndex,
  hasScreenshot,
  replayEpochs,
  screenshotUrl,
  type BrowserActionDetail,
  type BrowserActionMeta,
  type ReplayEpoch,
} from "../wire/browserWire";
import { clampStep, replayStage } from "./replayModel";

/** What the pane is doing, so the empty frame is never mistaken for a bug. */
type Load = "loading" | "ready";

/**
 * The replay of one stored session's browser run.
 *
 * @param props.sessionId whose record to replay, or null when the shown session
 *                        never minted an id
 */
export function BrowserReplay(props: { sessionId: string | null }): React.JSX.Element {
  const lang = useLang();
  const sessionId = props.sessionId;
  const [load, setLoad] = useState<Load>("loading");
  const [epochs, setEpochs] = useState<readonly ReplayEpoch[]>([]);
  const [which, setWhich] = useState(0);
  const [at, setAt] = useState(0);
  const [detail, setDetail] = useState<BrowserActionDetail | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad("loading");
    setEpochs([]);
    setWhich(0);
    setAt(0);
    setDetail(null);
    setDetailFor(null);
    if (sessionId === null) {
      setLoad("ready");
      return () => {
        alive = false;
      };
    }
    void fetchBrowserWireIndex(sessionId).then((rows) => {
      if (!alive) return;
      setEpochs(replayEpochs(rows));
      setLoad("ready");
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const epoch: ReplayEpoch | undefined = epochs[which];
  const steps: readonly BrowserActionMeta[] = epoch?.steps ?? [];
  const position = clampStep(at, steps.length);
  const step: BrowserActionMeta | undefined = steps[position];
  const stage = replayStage(steps, position);
  const stageUrl = stage === null ? null : screenshotUrl(stage);

  // The two recorded lines, on the step the reader is standing on. Fetched per
  // step rather than up front: the ledger is bodiless on purpose, and a run of a
  // thousand actions must not pull a thousand scripts into this tab to draw one.
  useEffect(() => {
    let alive = true;
    if (sessionId === null || step === undefined) {
      setDetail(null);
      setDetailFor(null);
      return () => {
        alive = false;
      };
    }
    const cid = step.cid;
    void fetchBrowserAction(sessionId, cid).then((found) => {
      if (!alive) return;
      setDetail(found);
      setDetailFor(cid);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, step]);

  const move = useCallback(
    (delta: number) => setAt((current) => clampStep(current + delta, steps.length)),
    [steps.length],
  );

  if (load === "loading") {
    return (
      <section className="browser-segment" aria-label={t(lang, "browser.replay.title")}>
        <div className="browser-bar">
          <span className="browser-dot" />
          <span className="browser-address">{t(lang, "browser.replay.loading")}</span>
        </div>
        <div className="browser-hole" />
      </section>
    );
  }

  if (steps.length === 0) {
    return (
      <section className="browser-segment" aria-label={t(lang, "browser.replay.title")}>
        <div className="browser-bar">
          <span className="browser-dot" />
          <span className="browser-address">{t(lang, "browser.replay.title")}</span>
        </div>
        <div className="browser-hole">
          <div className="browser-empty">
            <h2>{t(lang, "browser.replay.emptyTitle")}</h2>
            <p>{t(lang, "browser.replay.empty")}</p>
            <p className="browser-empty-hint">{t(lang, "browser.replay.emptyHint")}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="browser-segment" aria-label={t(lang, "browser.replay.title")}>
      <div className="browser-bar">
        <span className="browser-dot" data-attached={step?.ok === true} />
        <span className="browser-address">
          {step === undefined || step.pageUrl === "" ? t(lang, "browser.replay.noPage") : step.pageUrl}
        </span>
        {epochs.length > 1 && (
          <label className="replay-epoch">
            {t(lang, "browser.replay.browserLabel")}
            <select
              value={which}
              onChange={(e) => {
                setWhich(Number(e.target.value));
                setAt(0);
              }}
            >
              {epochs.map((e, i) => (
                <option key={e.epoch} value={i}>
                  {t(lang, "browser.replay.browserN", { n: e.epoch, count: e.steps.length })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="browser-hole">
        {stageUrl === null ? (
          <div className="browser-empty">
            <p>{t(lang, "browser.replay.noShotYet")}</p>
          </div>
        ) : (
          <figure className="replay-stage">
            <img
              src={stageUrl}
              alt={t(lang, "browser.replay.shotAlt")}
              className="replay-shot"
              data-stale={stage?.cid !== step?.cid}
            />
            {stage?.cid !== step?.cid && (
              <figcaption className="replay-held">{t(lang, "browser.replay.held")}</figcaption>
            )}
          </figure>
        )}
      </div>

      <div className="replay-scrub">
        <button
          type="button"
          className="replay-step-button"
          onClick={() => move(-1)}
          disabled={position === 0}
          aria-label={t(lang, "browser.replay.prev")}
        >
          ‹
        </button>
        <input
          type="range"
          className="replay-range"
          min={0}
          max={Math.max(steps.length - 1, 0)}
          step={1}
          value={position}
          onChange={(e) => setAt(Number(e.target.value))}
          aria-label={t(lang, "browser.replay.scrubber")}
        />
        <button
          type="button"
          className="replay-step-button"
          onClick={() => move(1)}
          disabled={position >= steps.length - 1}
          aria-label={t(lang, "browser.replay.next")}
        >
          ›
        </button>
        <span className="replay-count">
          {t(lang, "browser.replay.stepN", { n: position + 1, count: steps.length })}
        </span>
      </div>

      {step !== undefined && (
        <div className="replay-detail">
          <p className="replay-line">{browserStepSummary(step)}</p>
          {hasScreenshot(step) && (
            <p className="replay-line replay-line--dim">
              {t(lang, "browser.replay.shotAt", { w: step.width, h: step.height })}
            </p>
          )}
          {detailFor !== step.cid ? (
            <p className="replay-line replay-line--dim">{t(lang, "browser.replay.loading")}</p>
          ) : detail === null ? (
            <p className="replay-line replay-line--dim">{t(lang, "browser.replay.detailGone")}</p>
          ) : (
            <>
              <pre className="replay-payload">{JSON.stringify(detail.input, null, 2)}</pre>
              {detail.result !== null ? (
                <pre className="replay-payload">{detail.result}</pre>
              ) : (
                <p className="replay-line replay-line--dim">
                  {detail.omitted === "ceiling"
                    ? t(lang, "browser.replay.ceiling")
                    : detail.omitted === ""
                      ? t(lang, "browser.replay.stillOpen")
                      : t(lang, "browser.replay.redacted", { rule: detail.omitted })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <p className="browser-fence">{t(lang, "browser.replay.note")}</p>
    </section>
  );
}

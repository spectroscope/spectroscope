// The open llm_exchange row: the recorded request and response of ONE exchange,
// fetched from the sidecar on this expand and never sooner.
//
// The bodies are the one thing the socket frame deliberately does not carry
// (card 179: a body in the frame is a body in the row's search text), so this
// pane is where they finally appear — and where the same card's other lesson
// applies: a request body routinely holds base64 image blocks, and printing
// one raw is the defect the measured-gap segmentation was built to end. The
// cut is the very machinery the imported-picture face uses (state/
// sourceWindow.ts, PR #56): readable JSON, and every blob as a measured
// absence where it sits.
//
// Each side says an honest fidelity sentence first: what kind of recording the
// bytes below actually are. The two sides can differ — a request posted as
// bytes can come back reconstructed from the SDK's typed events.

import { useEffect, useMemo, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { cutAroundBlob } from "../state/sourceWindow";
import { withinBudget, SOURCE_DISPLAY_CHARS } from "./traceDetail";
import {
  fetchLlmExchange,
  fidelityKey,
  readExchange,
  type LlmExchangeDetail as ExchangeBodies,
  type LlmExchangeSide,
} from "../wire/llmWire";

/** How many response lines the pane paints before it stops and says so. A
 *  streamed answer is thousands of SSE lines; the cap names itself and the
 *  button below it lifts it. */
const RESPONSE_LINES_SHOWN = 200;

/** A count the way the reader's language groups it (TraceView's `counted`). */
const counted = (n: number, lang: Lang): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");

/** The fidelity sentence for one side — or, for a fidelity nobody wrote a
 *  sentence for, the bare word itself: honest, and loud enough to notice. */
function fidelitySentence(fidelity: string, lang: Lang): string | null {
  if (fidelity === "") return null;
  const key = fidelityKey(fidelity);
  return key === null ? fidelity : t(lang, key);
}

/** Text that stops at the shared ceiling and says it stopped — the source
 *  pane's rule, restated locally because TraceView's Budgeted is not exported
 *  and importing a component back out of it would be a cycle. */
function CappedText({ text, lang }: { text: string; lang: Lang }) {
  const [all, setAll] = useState(false);
  const cut = withinBudget(text, all ? text.length : SOURCE_DISPLAY_CHARS);
  return (
    <>
      <pre className="trace-detail-raw trace-detail-raw--wrap">{cut.text}</pre>
      {cut.capped && (
        <p className="trace-source-cap">
          {t(lang, "trace.source.capped", {
            shown: counted(cut.shown, lang),
            total: counted(cut.total, lang),
          })}{" "}
          <button type="button" className="trace-source-more" onClick={() => setAll(true)}>
            {t(lang, "trace.source.showAll")}
          </button>
        </p>
      )}
    </>
  );
}

/** One recorded payload, with every base64 run cut out as a measured gap. A
 *  text without a blob keeps the plain capped pane — the cut clips its gaps
 *  around the blobs, and clipping a body that has none would hide JSON for
 *  nothing. The mark is the lightbox's, but inert: there is no base64 face to
 *  open here, so it is a span and not a button. */
function SegmentedText({ text, lang }: { text: string; lang: Lang }) {
  const cut = useMemo(() => cutAroundBlob(text, 1), [text]);
  if (cut === null) return <CappedText text={text} lang={lang} />;
  return (
    <pre className="trace-detail-raw trace-detail-raw--wrap">
      {cut.segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className="img-blobmark llm-wire-mark" title={t(lang, "trace.llm.blobTitle")}>
            {t(lang, "shot.blob", { chars: seg.chars.toLocaleString() })}
          </span>
        ),
      )}
    </pre>
  );
}

/**
 * The sentence key for a side that has nothing to print, or null while there
 * is a body or lines below (or nothing honest to say). A ceiling-omitted body
 * was measured and then dropped by the recorder — silence under the fidelity
 * sentence would read as "recorded, and it was empty". A null response side
 * means the exchange never closed. An empty request side without the omitted
 * mark is an older server's shape; no sentence beats a guessed one.
 * Exported for the test seam.
 */
export function emptySideKey(side: LlmExchangeSide, isResponse: boolean): string | null {
  if (side.body !== null || side.lines.length > 0) return null;
  if (side.omitted === "ceiling") return "trace.llm.omittedCeiling";
  return isResponse ? "trace.llm.noResponse" : null;
}

/** One side of the exchange: its wire-word label, its fidelity sentence, and
 *  its bytes — the single body, or the streamed lines, each cut like a body. */
function Side({ label, side, lang }: { label: string; side: LlmExchangeSide; lang: Lang }) {
  const sentence = fidelitySentence(side.fidelity, lang);
  const emptyKey = emptySideKey(side, label === "response");
  const [allLines, setAllLines] = useState(false);
  const lines = side.lines;
  const shown = allLines ? lines : lines.slice(0, RESPONSE_LINES_SHOWN);
  return (
    <div className="ed-sec">
      {/* The endpoint's own field name, printed verbatim — the trace is the
          wire view, and `request` is the field, not a word we chose. */}
      <span className="ed-label mono">{label}</span>
      {sentence !== null && <p className="trace-source-note">{sentence}</p>}
      {/* The wire facts the side carries, when it carries them. */}
      {(side.method !== "" || side.url !== "") && (
        <div className="ed-path mono">{[side.method, side.url].filter((s) => s !== "").join(" ")}</div>
      )}
      {side.error !== "" && <p className="trace-source-note">{side.error}</p>}
      {emptyKey !== null && <p className="trace-source-note">{t(lang, emptyKey)}</p>}
      {side.body !== null && <SegmentedText text={side.body} lang={lang} />}
      {side.body === null && shown.map((line, i) => <SegmentedText key={i} text={line} lang={lang} />)}
      {side.body === null && lines.length > RESPONSE_LINES_SHOWN && !allLines && (
        <p className="trace-source-cap">
          {t(lang, "trace.llm.linesCap", {
            shown: counted(shown.length, lang),
            total: counted(lines.length, lang),
          })}{" "}
          <button type="button" className="trace-source-more" onClick={() => setAllLines(true)}>
            {t(lang, "trace.source.showAll")}
          </button>
        </p>
      )}
    </div>
  );
}

export function LlmExchangeDetail({
  payload,
  sessionId,
}: {
  /** The row's own frame — the xid to fetch by is read out of it. */
  payload: unknown;
  /** The session whose sidecar holds the bodies, or null when there is none
   *  to ask: an import, a scenario, an entered fleet. Null means NO fetch. */
  sessionId: string | null;
}) {
  const lang = useLang();
  const meta = useMemo(() => readExchange(payload), [payload]);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; bodies: ExchangeBodies }
  >({ kind: "loading" });

  const xid = meta?.xid ?? null;
  useEffect(() => {
    if (sessionId === null || xid === null) return;
    let alive = true;
    setState({ kind: "loading" });
    void fetchLlmExchange(sessionId, xid).then((bodies) => {
      if (!alive) return;
      setState(bodies === null ? { kind: "failed" } : { kind: "loaded", bodies });
    });
    return () => {
      alive = false;
    };
  }, [sessionId, xid]);

  // A frame this cannot read has no xid to fetch by; the frame itself is the
  // only honest thing to show, and the wire face's bytes are one click away.
  if (meta === null) {
    return <pre className="trace-detail-raw trace-detail-raw--wrap">{JSON.stringify(payload)}</pre>;
  }
  // No sidecar to ask. For an imported transcript this is the honest
  // provenance sentence rather than a fetch that could only 404: the file's
  // own record IS its wire, and nothing beside it holds our recording.
  if (sessionId === null) {
    return <p className="trace-source-note">{t(lang, "trace.llm.imported")}</p>;
  }
  if (state.kind === "loading") {
    return <p className="trace-source-note">{t(lang, "trace.llm.loading")}</p>;
  }
  if (state.kind === "failed") {
    return <p className="trace-source-note">{t(lang, "trace.llm.failed")}</p>;
  }
  return (
    <div className="ed">
      <Side label="request" side={state.bodies.request} lang={lang} />
      <Side label="response" side={state.bodies.response} lang={lang} />
    </div>
  );
}

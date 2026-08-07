// The open llm_exchange row: the recorded request and response of ONE exchange,
// fetched from the sidecar on this expand and never sooner.
//
// ALL THREE FACES READ THE FETCHED EXCHANGE (card 184, owner 2026-08-07). That
// sentence is the whole repair. The rejected version fetched the bodies for the
// structured face alone; insight, wire and source went on reading `entry.payload`,
// which is the metadata frame. So the owner opened three faces and saw the
// postmark three times while the letter sat one fetch away. The bodies were
// never missing, they were misrouted.
//
//   structured — the request in its PARTS: settings, system prompt, N messages,
//                N tools, each collapsible. Never a wall of JSON: that was the
//                complaint, and "structured" means rendered as the thing it is.
//   insight    — the collapsible tree over the PARSED body, not over the frame
//                we built to announce it.
//   wire       — the literal exchange: the POST line, the headers as recorded,
//                a blank line, the body; then one row per received stream line.
//   source     — NOT OFFERED here (state/traceFace.ts). Byte-exactness would
//                need the raw line, and the endpoint hands over parsed nodes. A
//                face is hidden rather than filled with a riddle.
//
// Nothing on any face prints base64: a request body routinely holds image
// blocks, and the measured-gap segmentation (state/sourceWindow.ts, PR #56) is
// what stands in for them. Each side says its fidelity sentence first, and the
// two sides can differ.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { cutAroundBlob } from "../state/sourceWindow";
import { withinBudget, SOURCE_DISPLAY_CHARS } from "./traceDetail";
import { JsonTree } from "./JsonTree";
import { formatBytes } from "../workspace/preview";
import { formatDuration } from "../format";
import { readRequestParts, type LlmBlock, type LlmRequestParts } from "../wire/llmRequestParts";
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

/** How many messages and tools open unfolded. A replayed history is the whole
 *  conversation every turn, and 60 open blocks is the wall of JSON again in a
 *  different typeface. */
const PARTS_SHOWN = 40;

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
function CappedText({ text: body, lang }: { text: string; lang: Lang }) {
  const [all, setAll] = useState(false);
  const cut = withinBudget(body, all ? body.length : SOURCE_DISPLAY_CHARS);
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
function SegmentedText({ text: body, lang }: { text: string; lang: Lang }) {
  const cut = useMemo(() => cutAroundBlob(body, 1), [body]);
  if (cut === null) return <CappedText text={body} lang={lang} />;
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

/** A collapsible part. The head carries its own count, so a reader decides
 *  whether to open it BEFORE paying for it — which is the difference between
 *  parts and the wall of JSON they replace. */
function Fold({
  label,
  note,
  open: initial,
  children,
}: {
  label: string;
  note?: string;
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial ?? false);
  return (
    <div className="lw-fold">
      <button type="button" className="lw-fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lw-fold-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="lw-fold-label mono">{label}</span>
        {note !== undefined && note !== "" && <span className="lw-fold-note">{note}</span>}
      </button>
      {open && <div className="lw-fold-body">{children}</div>}
    </div>
  );
}

/** One content block of one message. A blob is a measurement and never its
 *  bytes; a text is the text, capped like every other pane here. */
function Block({ block, lang }: { block: LlmBlock; lang: Lang }) {
  const head = block.name !== "" ? `${block.wire || block.kind} · ${block.name}` : block.wire || block.kind;
  return (
    <div className="lw-block">
      <span className="lw-block-kind mono">{head}</span>
      {block.chars > 0 && (
        <span className="img-blobmark llm-wire-mark" title={t(lang, "trace.llm.blobTitle")}>
          {t(lang, "shot.blob", { chars: block.chars.toLocaleString() })}
        </span>
      )}
      {block.text !== "" && <CappedText text={block.text} lang={lang} />}
    </div>
  );
}

/** The request as its parts. The one rule that keeps this honest: a body in a
 *  shape this reader does not know says so and hands over to the tree, because
 *  an empty pane would read as "the request was empty". */
function RequestParts({ parts, body, lang }: { parts: LlmRequestParts; body: string; lang: Lang }) {
  if (parts.empty) {
    return (
      <>
        <p className="trace-source-note">{t(lang, "trace.llm.parts.unknownShape")}</p>
        <JsonTree value={safeParse(body)} defaultDepth={3} />
      </>
    );
  }
  const messages = parts.messages.slice(0, PARTS_SHOWN);
  const tools = parts.tools.slice(0, PARTS_SHOWN);
  return (
    <div className="lw-parts">
      {parts.config.length > 0 && (
        <dl className="ed-rows">
          {parts.config.map((c) => (
            <div key={c.key}>
              <dt className="mono">{c.key}</dt>
              <dd className="mono">{c.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {parts.system !== "" && (
        <Fold
          label={t(lang, "trace.llm.parts.system")}
          note={t(lang, "trace.llm.parts.chars", { chars: counted(parts.system.length, lang) })}
        >
          <CappedText text={parts.system} lang={lang} />
        </Fold>
      )}
      {parts.messages.length > 0 && (
        <Fold
          label={t(lang, "trace.llm.parts.messages")}
          note={counted(parts.messages.length, lang)}
          open={parts.messages.length <= 3}
        >
          {messages.map((m, i) => (
            <Fold
              key={i}
              label={m.role}
              note={
                m.blocks.length === 1
                  ? t(lang, "trace.llm.parts.block1")
                  : t(lang, "trace.llm.parts.blocks", { n: counted(m.blocks.length, lang) })
              }
              open={parts.messages.length <= 3}
            >
              {m.blocks.map((b, j) => (
                <Block key={j} block={b} lang={lang} />
              ))}
            </Fold>
          ))}
          {parts.messages.length > PARTS_SHOWN && (
            <p className="ed-more">
              {t(lang, "trace.llm.parts.more", {
                shown: counted(PARTS_SHOWN, lang),
                total: counted(parts.messages.length, lang),
              })}
            </p>
          )}
        </Fold>
      )}
      {parts.tools.length > 0 && (
        <Fold label={t(lang, "trace.llm.parts.tools")} note={counted(parts.tools.length, lang)}>
          {tools.map((tool, i) => (
            <Fold key={i} label={tool.name} note={tool.description}>
              <JsonTree value={tool.schema} defaultDepth={99} />
            </Fold>
          ))}
          {parts.tools.length > PARTS_SHOWN && (
            <p className="ed-more">
              {t(lang, "trace.llm.parts.more", {
                shown: counted(PARTS_SHOWN, lang),
                total: counted(parts.tools.length, lang),
              })}
            </p>
          )}
        </Fold>
      )}
    </div>
  );
}

/** The response as facts we MEASURED, not as an answer we rebuilt. Reassembling
 *  the stream in the browser would be a second implementation of what the Java
 *  side already does, and two reassemblers drift. The reassembled answer is the
 *  chat; the trace's job is what arrived, and that is one row per line on the
 *  wire face. */
function ResponseFacts({
  side,
  durationMs,
  lang,
}: {
  side: LlmExchangeSide;
  durationMs: number;
  lang: Lang;
}) {
  const facts: string[] = [];
  if (side.status !== 0) facts.push(String(side.status));
  if (side.lines.length > 0)
    facts.push(t(lang, "trace.llm.res.lines", { n: counted(side.lines.length, lang) }));
  if (side.bodyBytes > 0) facts.push(formatBytes(side.bodyBytes));
  if (durationMs > 0) facts.push(formatDuration(durationMs));
  if (side.aborted) facts.push(t(lang, "trace.llm.res.aborted"));
  return (
    <>
      {facts.length > 0 && <div className="ed-path mono">{facts.join(" · ")}</div>}
      <p className="trace-source-note">{t(lang, "trace.llm.res.noReassembly")}</p>
    </>
  );
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** The stream's lines as objects where they are objects. An SSE line is
 *  `data: {...}`; the prefix is the transport's, the object is the payload, and
 *  the tree is a tree over payloads. A line that is neither stays a string, so
 *  a `[DONE]` or a comment is visible as itself rather than dropped. */
function parseLines(lines: readonly string[]): unknown[] {
  return lines.map((line) => {
    const body = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (body === "" || body === "[DONE]" || !(body.startsWith("{") || body.startsWith("["))) return line;
    try {
      return JSON.parse(body);
    } catch {
      return line;
    }
  });
}

/** The literal exchange, in the order it happened on the socket. */
function WireFace({ bodies, lang }: { bodies: ExchangeBodies; lang: Lang }) {
  const { request, response } = bodies;
  const [allLines, setAllLines] = useState(false);
  const shown = allLines ? response.lines : response.lines.slice(0, RESPONSE_LINES_SHOWN);
  const headers = Object.entries(request.headers);
  return (
    <div className="ed">
      <div className="ed-sec">
        <span className="ed-label mono">request</span>
        {sentenceOf(request, lang)}
        {/* The request line as HTTP writes it, then the headers as recorded,
            then a blank line and the body: the shape of the thing that left. */}
        <pre className="trace-detail-raw trace-detail-raw--wrap lw-http">
          {[request.method, request.url].filter((s) => s !== "").join(" ")}
        </pre>
        {headers.length > 0 ? (
          <pre className="trace-detail-raw trace-detail-raw--wrap lw-http">
            {headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
          </pre>
        ) : (
          <p className="trace-source-note">{t(lang, "trace.llm.wire.noHeaders")}</p>
        )}
        {request.body !== null && <SegmentedText text={request.body} lang={lang} />}
        {emptyNote(request, false, lang)}
      </div>
      <div className="ed-sec">
        <span className="ed-label mono">response</span>
        {sentenceOf(response, lang)}
        {response.error !== "" && <p className="trace-source-note">{response.error}</p>}
        {response.body !== null && <SegmentedText text={response.body} lang={lang} />}
        {response.body === null &&
          shown.map((line, i) => (
            <div key={i} className="lw-line">
              <span className="lw-line-no mono">{i + 1}</span>
              <SegmentedText text={line} lang={lang} />
            </div>
          ))}
        {response.body === null && response.lines.length > RESPONSE_LINES_SHOWN && !allLines && (
          <p className="trace-source-cap">
            {t(lang, "trace.llm.linesCap", {
              shown: counted(shown.length, lang),
              total: counted(response.lines.length, lang),
            })}{" "}
            <button type="button" className="trace-source-more" onClick={() => setAllLines(true)}>
              {t(lang, "trace.source.showAll")}
            </button>
          </p>
        )}
        {emptyNote(response, true, lang)}
      </div>
    </div>
  );
}

function sentenceOf(side: LlmExchangeSide, lang: Lang): ReactNode {
  const sentence = fidelitySentence(side.fidelity, lang);
  return sentence === null ? null : <p className="trace-source-note">{sentence}</p>;
}

function emptyNote(side: LlmExchangeSide, isResponse: boolean, lang: Lang): ReactNode {
  const key = emptySideKey(side, isResponse);
  return key === null ? null : <p className="trace-source-note">{t(lang, key)}</p>;
}

export function LlmExchangeDetail({
  payload,
  sessionId,
  face,
}: {
  /** The row's own frame — the xid to fetch by is read out of it. */
  payload: unknown;
  /** The session whose sidecar holds the bodies, or null when there is none
   *  to ask: an import, a scenario, an entered fleet. Null means NO fetch. */
  sessionId: string | null;
  /** Which face this row is showing. Every face reads the SAME fetch. */
  face: "structured" | "insight" | "wire";
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

  const bodies = state.kind === "loaded" ? state.bodies : null;
  const parts = useMemo(() => (bodies === null ? null : readRequestParts(bodies.request.body)), [bodies]);

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
  if (bodies === null || parts === null) {
    return <p className="trace-source-note">{t(lang, "trace.llm.failed")}</p>;
  }

  if (face === "wire") {
    return <WireFace bodies={bodies} lang={lang} />;
  }

  if (face === "insight") {
    // The tree over the PARSED bodies, which is what the face promises. Over
    // the frame it would be the postmark again.
    return (
      <div className="ed">
        <div className="ed-sec">
          <span className="ed-label mono">request</span>
          {sentenceOf(bodies.request, lang)}
          {bodies.request.body === null ? (
            emptyNote(bodies.request, false, lang)
          ) : (
            <JsonTree value={safeParse(bodies.request.body)} defaultDepth={4} />
          )}
        </div>
        <div className="ed-sec">
          <span className="ed-label mono">response</span>
          {sentenceOf(bodies.response, lang)}
          {bodies.response.body !== null ? (
            <JsonTree value={safeParse(bodies.response.body)} defaultDepth={4} />
          ) : bodies.response.lines.length > 0 ? (
            <JsonTree value={parseLines(bodies.response.lines)} defaultDepth={3} />
          ) : (
            emptyNote(bodies.response, true, lang)
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ed">
      <div className="ed-sec">
        <span className="ed-label mono">request</span>
        {sentenceOf(bodies.request, lang)}
        {bodies.request.body === null ? (
          emptyNote(bodies.request, false, lang)
        ) : (
          <RequestParts parts={parts} body={bodies.request.body} lang={lang} />
        )}
      </div>
      <div className="ed-sec">
        <span className="ed-label mono">response</span>
        {sentenceOf(bodies.response, lang)}
        {bodies.response.lines.length === 0 && bodies.response.body === null ? (
          emptyNote(bodies.response, true, lang)
        ) : (
          <ResponseFacts side={bodies.response} durationMs={meta.durationMs} lang={lang} />
        )}
      </div>
    </div>
  );
}

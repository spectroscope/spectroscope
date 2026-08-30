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
import { AudioClipCard } from "./AudioClipCard";
import { cutAroundBlob } from "../state/sourceWindow";
import { withinBudget, SOURCE_DISPLAY_CHARS } from "./traceDetail";
import { ALL_LEVELS, JsonTree } from "./JsonTree";
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

/** How many lines the structured face's response facts print before it says it
 *  stopped. Named because the reservation below has to agree with it: a
 *  reservation for lines the pane will not paint is a reservation for nothing. */
const RESPONSE_LINES_IN_FACTS = 20;

/** How many messages and tools open unfolded. A replayed history is the whole
 *  conversation every turn, and 60 open blocks is the wall of JSON again in a
 *  different typeface. */
const PARTS_SHOWN = 40;

/** A count the way the reader's language groups it (TraceView's `counted`). */
const counted = (n: number, lang: Lang): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");

// Card 211, the second half. This is the ONE detail in the trace that arrives
// late: it paints a single line, fetches the bodies from the sidecar, and a few
// milliseconds later replaces that line with hundreds of pixels. Measured on the
// owner's session: 82 px at first paint, 1,143 px six milliseconds later, under
// a reader who did not scroll. So the pane says up front roughly how much room
// it is going to need — and the frame already knows, because the collapsed row
// prints it: "20 lines · 2 kB · 4.5 s" comes from `llmResponseSummary`, off the
// same `responseLines` read below.
//
// The three constants are MEASURED, not chosen. Instrumented in Chrome at
// 1440x880 on 20260810-230306-72871659, seq 5.5, the structured face:
//   face strip 27 + expand strip 27 + label 17 + fidelity sentence 19 +
//   facts line 17 + the detail's own 8/12 padding  = 107 px of chrome
//   the response section was 1,041 px over 20 printed lines = 52 px a line

/** Everything above and below the printed lines, in pixels. */
const LW_CHROME_PX = 107;
/** One recorded line as this pane prints it, wrapping included. */
const LW_LINE_PX = 52;
/** No reservation is taller than this. A reserved height is an estimate, and an
 *  estimate that opens a screen-and-a-half of empty pane is worse than the step
 *  it prevents. */
const LW_RESERVE_MAX_PX = 2400;

/**
 * How tall the loaded pane is expected to be, read off the FRAME alone — before
 * a byte of the body has been fetched.
 *
 * Deliberately an estimate and never a promise: it is applied as a `min-height`
 * on the loading note and released the moment the bodies land, so a body that
 * turns out taller simply grows past it and a shorter one is never padded. The
 * measured residual on the owner's row is +43 px, against +1,061 px without it.
 *
 * @param lines what the frame says came back (`responseLines`)
 * @param face which face is about to render
 * @param half which half of the exchange this row is
 * @return the pixels to hold open, or 0 when the frame says nothing usable —
 *         a non-streamed body carries no line count, and guessing a height from
 *         a byte size would be a guess dressed as a measurement
 */
export function llmReservePx(
  lines: number,
  face: "structured" | "insight" | "wire",
  half: "request" | "response" | "both",
): number {
  // Which panes print the received lines at all. The structured face shows them
  // only on the RESPONSE row — under a request they would bury it — while the
  // wire and insight faces print them for every half that has a response.
  const printsLines = face === "structured" ? half === "response" : half !== "request";
  if (!printsLines || lines <= 0) return 0;
  // Each face stops at its own count, and reserving past that would hold open
  // room for lines the pane is never going to paint.
  const cap = face === "structured" ? RESPONSE_LINES_IN_FACTS : RESPONSE_LINES_SHOWN;
  return Math.min(LW_CHROME_PX + Math.min(lines, cap) * LW_LINE_PX, LW_RESERVE_MAX_PX);
}

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

/** Open everything at once, and back (owner 2026-08-07). Two buttons rather
 *  than a toggle: "default" has to mean the pane as it OPENED — folds a reader
 *  clicked open since included — and a toggle that left those standing would
 *  not be a way back. The epoch is what makes that true: it remounts the panes,
 *  so every fold and every tree node returns to the state it is born in. */
function ExpandStrip({
  all,
  onChange,
  lang,
}: {
  all: boolean;
  onChange: (all: boolean) => void;
  lang: Lang;
}) {
  return (
    <div
      className="trace-detail-modes trace-reading"
      role="group"
      aria-label={t(lang, "trace.llm.expandAria")}
    >
      <button type="button" aria-pressed={all} onClick={() => onChange(true)}>
        {t(lang, "trace.llm.expandAll")}
      </button>
      <button type="button" aria-pressed={!all} onClick={() => onChange(false)}>
        {t(lang, "trace.llm.expandDefault")}
      </button>
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
function RequestParts({
  parts,
  body,
  lang,
  expandAll,
}: {
  parts: LlmRequestParts;
  body: string;
  lang: Lang;
  /** Owner 2026-08-07: open every fold at once. The container is remounted on
   *  each change (see the key in the caller), so "default" really is the pane
   *  as it opened rather than whatever a reader had clicked open since. */
  expandAll: boolean;
}) {
  if (parts.empty) {
    const parsed = safeParse(body);
    return (
      <>
        <p className="trace-source-note">{t(lang, "trace.llm.parts.unknownShape")}</p>
        {typeof parsed === "string" ? (
          /* A body that is not JSON at all reaches the tree as one string
             leaf, which JsonTree prints WHOLE — for an encoded body that was
             the wall of base64 this face is meant to prevent. The gap cutter
             is the rule everywhere else; it applies here too. */
          <SegmentedText text={parsed} lang={lang} />
        ) : (
          <JsonTree value={parsed} defaultDepth={expandAll ? ALL_LEVELS : 3} />
        )}
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
          open={expandAll}
        >
          <CappedText text={parts.system} lang={lang} />
        </Fold>
      )}
      {parts.messages.length > 0 && (
        <Fold
          label={t(lang, "trace.llm.parts.messages")}
          note={counted(parts.messages.length, lang)}
          open={expandAll || parts.messages.length <= 3}
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
              open={expandAll || parts.messages.length <= 3}
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
        <Fold
          label={t(lang, "trace.llm.parts.tools")}
          note={counted(parts.tools.length, lang)}
          open={expandAll}
        >
          {tools.map((tool, i) => (
            <Fold key={i} label={tool.name} note={tool.description} open={expandAll}>
              <JsonTree value={tool.schema} defaultDepth={ALL_LEVELS} />
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
  showLines = false,
  expandAll = false,
}: {
  side: LlmExchangeSide;
  durationMs: number;
  lang: Lang;
  /** Whether the received lines belong in THIS pane. On a response row they are
   *  the subject; under a request they would bury it. */
  showLines?: boolean;
  expandAll?: boolean;
}) {
  const facts: string[] = [];
  if (side.status !== 0) facts.push(String(side.status));
  if (side.lines.length > 0)
    facts.push(t(lang, "trace.llm.res.lines", { n: counted(side.lines.length, lang) }));
  if (side.bodyBytes > 0) facts.push(formatBytes(side.bodyBytes));
  if (durationMs > 0) facts.push(formatDuration(durationMs));
  if (side.aborted) facts.push(t(lang, "trace.llm.res.aborted"));
  const cap = expandAll ? side.lines.length : Math.min(side.lines.length, RESPONSE_LINES_IN_FACTS);
  return (
    <>
      {facts.length > 0 && <div className="ed-path mono">{facts.join(" · ")}</div>}
      <p className="trace-source-note">{t(lang, "trace.llm.res.noReassembly")}</p>
      {showLines && side.body !== null && <SegmentedText text={side.body} lang={lang} />}
      {showLines &&
        side.body === null &&
        side.lines.slice(0, cap).map((line, i) => (
          <div key={i} className="lw-line">
            <span className="lw-line-no mono">{i + 1}</span>
            <SegmentedText text={line} lang={lang} />
          </div>
        ))}
      {showLines && side.body === null && cap < side.lines.length && (
        <p className="trace-source-cap">
          {t(lang, "trace.llm.linesCap", {
            shown: counted(cap, lang),
            total: counted(side.lines.length, lang),
          })}
        </p>
      )}
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
function WireFace({
  bodies,
  lang,
  half,
}: {
  bodies: ExchangeBodies;
  lang: Lang;
  half: "request" | "response" | "both";
}) {
  const { request, response } = bodies;
  const [allLines, setAllLines] = useState(false);
  const shown = allLines ? response.lines : response.lines.slice(0, RESPONSE_LINES_SHOWN);
  const headers = Object.entries(request.headers);
  return (
    <div className="ed">
      {half !== "response" && (
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
      )}
      {half !== "request" && (
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
      )}
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
  half = "both",
}: {
  /** The row's own frame — the xid to fetch by is read out of it. */
  payload: unknown;
  /** The session whose sidecar holds the bodies, or null when there is none
   *  to ask: an import, a scenario, an entered fleet. Null means NO fetch. */
  sessionId: string | null;
  /** Which face this row is showing. Every face reads the SAME fetch. */
  face: "structured" | "insight" | "wire";
  /** Which half of the exchange this row IS. A request row shows the request
   *  and says nothing about an answer it cannot have seen yet; a response row
   *  shows what came back; the summary row shows both, as it always did. */
  half?: "request" | "response" | "both";
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

  // How far the two rendered faces are unfolded. The epoch remounts them, so
  // "default" is the pane as it opened rather than whatever was clicked since.
  const [expandAll, setExpandAll] = useState(false);
  const [expandEpoch, setExpandEpoch] = useState(0);
  const setExpand = (all: boolean): void => {
    setExpandAll(all);
    setExpandEpoch((e) => e + 1);
  };

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
    // The room the answer is going to need, held open while it travels (card
    // 211). A min-height, so a taller body grows past it rather than being
    // clipped, and it is gone the instant the pane renders for real.
    const reserve = llmReservePx(meta.responseLines, face, half);
    return (
      <p
        className="trace-source-note"
        style={reserve > 0 ? { minHeight: reserve } : undefined}
        data-llm-reserve={reserve > 0 ? reserve : undefined}
      >
        {t(lang, "trace.llm.loading")}
      </p>
    );
  }
  if (state.kind === "failed") {
    // No reservation on the way out. `failed` and the imported sentence above
    // are terminal one-liners: nothing further will arrive to fill the room, and
    // holding a screenful open under a permanent sentence is the "padded
    // forever" the card rules out. The step here is downwards, once, and rare.
    return <p className="trace-source-note">{t(lang, "trace.llm.failed")}</p>;
  }
  if (bodies === null || parts === null) {
    return <p className="trace-source-note">{t(lang, "trace.llm.failed")}</p>;
  }

  if (face === "wire") {
    return <WireFace bodies={bodies} lang={lang} half={half} />;
  }

  if (face === "insight") {
    // The tree over the PARSED bodies, which is what the face promises. Over
    // the frame it would be the postmark again.
    const depth = expandAll ? ALL_LEVELS : 4;
    return (
      <div className="ed">
        <ExpandStrip all={expandAll} onChange={setExpand} lang={lang} />
        {half !== "response" && (
          <div className="ed-sec" key={`req-${expandEpoch}`}>
            <span className="ed-label mono">request</span>
            {sentenceOf(bodies.request, lang)}
            {bodies.request.body === null ? (
              emptyNote(bodies.request, false, lang)
            ) : (
              <JsonTree value={safeParse(bodies.request.body)} defaultDepth={depth} />
            )}
          </div>
        )}
        {half !== "request" && (
          <div className="ed-sec" key={`res-${expandEpoch}`}>
            <span className="ed-label mono">response</span>
            {sentenceOf(bodies.response, lang)}
            {bodies.response.body !== null ? (
              <JsonTree value={safeParse(bodies.response.body)} defaultDepth={depth} />
            ) : bodies.response.lines.length > 0 ? (
              <JsonTree value={parseLines(bodies.response.lines)} defaultDepth={expandAll ? ALL_LEVELS : 3} />
            ) : (
              emptyNote(bodies.response, true, lang)
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ed">
      <ExpandStrip all={expandAll} onChange={setExpand} lang={lang} />
      {half !== "response" && (
        <div className="ed-sec" key={`parts-${expandEpoch}`}>
          <span className="ed-label mono">request</span>
          {sentenceOf(bodies.request, lang)}
          {bodies.request.body === null ? (
            emptyNote(bodies.request, false, lang)
          ) : meta.kind === "stt" ? (
            /* An stt body is the recording's own base64 of the WAV (fidelity
               "encoded", both routes). The parts reader cannot know that shape,
               and the tree fallback would print the wall of base64 the
               measured-gap idiom exists to prevent. So the structured face
               shows the recording as what it is: playable audio, the words the
               model heard, and the window into the encoded text. */
            <AudioClipCard body={bodies.request.body} responseBody={bodies.response.body} />
          ) : (
            <RequestParts parts={parts} body={bodies.request.body} lang={lang} expandAll={expandAll} />
          )}
        </div>
      )}
      <div className="ed-sec">
        <span className="ed-label mono">response</span>
        {sentenceOf(bodies.response, lang)}
        {bodies.response.lines.length === 0 && bodies.response.body === null ? (
          emptyNote(bodies.response, true, lang)
        ) : (
          <ResponseFacts
            side={bodies.response}
            durationMs={meta.durationMs}
            lang={lang}
            /* On the RESPONSE row the answer is the subject, not a footnote
               under the request (owner 2026-08-07: "die llm response legt noch
               zu viel Wert auf den Request"). So the lines it received are
               shown here rather than only one face away. Still not reassembled:
               these are the lines as they arrived. */
            showLines={half === "response"}
            expandAll={expandAll}
          />
        )}
      </div>
    </div>
  );
}

// Claude-Code-style context gauge: a small donut in the header showing how
// full the model's context window is. The value is usage truth (the last
// reported inputTokens of the main agent) against the window the run states,
// or against its compaction threshold when it states no window (card 377).
// The popover adds the char/4 introspection when the harness emits
// context_info (an additive extra); without it the ring still works.
//
// CARD 366 — THE WINDOW COMES FROM THE RUN NOW. The line naming the window has
// been here since card 300 and never appeared for a local model: the web
// answered "which window?" from a hand-typed vendor prefix table that returned
// null for everything that was not Claude, GPT or Gemini. The harness had
// measured the real answer all along and dropped it before the wire. It now
// rides on context_info, with its provenance, and the table lives in Java
// beside the code that derives the threshold from it (ModelWindows).
//
// CARD 390: THE OPERATOR CAN SET THE WINDOW FOR THIS SESSION HERE. The owner,
// 2026-09-23: "man oben in dem ring eine override einstellung hat, um das
// fenster fuer diese session zu overriden". The popover carries one row for it
// in the live view; the server decides the range, answers at once, and every
// later context_info names the window with the source `window_override`.

import { Fragment, useEffect, useRef, useState } from "react";
import type { ContextSnapshot } from "../state/reducer";
import { formatCredits, formatTokens } from "../format";
import { formatWindow } from "./contextWindow";
import { contextGauge, namedWindow, type ContextGauge } from "./contextRingMath";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { parseWindowDraft, WINDOW_OVERRIDE_CEILING, WINDOW_OVERRIDE_FLOOR } from "../wire/windowOverride";

const SIZE = 18;
const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;
// Gauge tones — deliberately mirrors the CLI gauge's thresholds.
const WARM_AT_PCT = 70;
const CRITICAL_AT_PCT = 90;
/** How far the compaction notch reaches either side of the 2.5-wide band. */
const MARK_INNER = 5.2;
const MARK_OUTER = 8.8;

/**
 * The compaction notch, as two points on the ring.
 *
 * Twelve o'clock is zero, the way the arc above it starts, so the angle is the
 * fraction minus a quarter turn. Rounded to two places because this markup is
 * pinned by a test and a float tail would make the pin a machine detail.
 */
function markTick(frac: number): { x1: string; y1: string; x2: string; y2: string } {
  const a = frac * 2 * Math.PI - Math.PI / 2;
  const at = (r: number) => ({
    x: (SIZE / 2 + r * Math.cos(a)).toFixed(2),
    y: (SIZE / 2 + r * Math.sin(a)).toFixed(2),
  });
  const inner = at(MARK_INNER);
  const outer = at(MARK_OUTER);
  return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
}

export function ContextRing(props: {
  lastInputTokens: number;
  context: ContextSnapshot | null;
  /** Sets (a number) or clears (null) the window for this session (card 390).
   *  Undefined where nothing can receive it, the replay view; the popover then
   *  draws no row. Required as a key so a caller cannot drop it by omission. */
  onWindowOverride: ((tokens: number | null) => void) | undefined;
  /** The session's cost in GitHub AI credits, or null when no call reported
   *  one (card 496). Undefined draws no line, like null. */
  aiCredits?: number | null;
}) {
  const { lastInputTokens, context } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // The window the RUN reported, not a guess about the model's name. It arrives
  // on the same frame as the threshold, and since card 377 it is what the gauge
  // divides by whenever the harness derived that threshold from it.
  const gauge = contextGauge(context?.threshold, context?.contextWindow, context?.thresholdSource);
  const scale = gauge.denominator.value;
  const pct = scale > 0 ? (lastInputTokens / scale) * 100 : 0;
  const shownPct = Math.round(pct);
  const frac = Math.max(0, Math.min(1, pct / 100));
  // THE TONES FOLLOW THE MARK, NOT THE SCALE. They are the gauge's warning, and
  // what they warn about is compaction, which is a fixed 70 % of the window
  // whenever the window is the scale. Leaving them on the scale would have made
  // the whole 70 % of the ring calm and the red arc unreachable: this gauge
  // would never turn red again on the owner's own backend. So the percentage
  // they read is the share of the compaction point, which is what they read
  // before this card and at the same token counts.
  const markAt = gauge.compactsAt;
  const toneBasis = markAt ?? scale;
  const tonePct = toneBasis > 0 ? (lastInputTokens / toneBasis) * 100 : 0;
  const tone =
    tonePct < WARM_AT_PCT ? "var(--ok)" : tonePct <= CRITICAL_AT_PCT ? "var(--warn)" : "var(--error)";
  const mark = markAt === null ? null : markTick(markAt / scale);

  // Esc and outside-click close the popover — it is a glance, not a modal.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="context-wrap" ref={wrapRef}>
      <button
        type="button"
        className="context-ring"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context ${shownPct} percent full — details`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={tone}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${frac * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
          {mark !== null && (
            <line
              className="context-ring-mark"
              x1={mark.x1}
              y1={mark.y1}
              x2={mark.x2}
              y2={mark.y2}
              stroke="var(--text)"
              strokeWidth="1.5"
            />
          )}
        </svg>
        <span className="tabular">{shownPct}%</span>
      </button>

      {open && (
        <ContextPopover
          lastInputTokens={lastInputTokens}
          context={context}
          gauge={gauge}
          shownPct={shownPct}
          onWindowOverride={props.onWindowOverride}
          aiCredits={props.aiCredits}
        />
      )}
    </span>
  );
}

/**
 * The popover's whole content.
 *
 * Its own component because the ring's button is all that renders while it is
 * closed, and this gate has no DOM to click with — so the half that carries
 * the numbers would otherwise be pinned by nothing. It holds no state and makes
 * no decision the ring has not already made: which window to name and what to
 * call it is `namedWindow`, next to the denominator it belongs under, and what
 * the headline divides by is `contextGauge`, which the ring hands in.
 */
export function ContextPopover(props: {
  lastInputTokens: number;
  context: ContextSnapshot | null;
  gauge: ContextGauge;
  shownPct: number;
  /** See ContextRing: undefined draws no row. */
  onWindowOverride: ((tokens: number | null) => void) | undefined;
  /** See ContextRing: null or undefined draws no credit line. */
  aiCredits?: number | null;
}) {
  const { lastInputTokens, context, gauge, shownPct, onWindowOverride, aiCredits } = props;
  const lang = useLang();
  const [draft, setDraft] = useState("");
  // On only when the frame says the operator's window decided. Keyed on the
  // source word and nothing else: `override` is the settings threshold, and
  // the reverted first build read that one (review 2026-09-24, E4).
  const activeWindow =
    context?.thresholdSource === "window_override" && context.contextWindow !== undefined
      ? context.contextWindow
      : null;
  const denominator = gauge.denominator;
  // NOT called `window`: this is a browser component, and a local binding of
  // that name shadows the global inside the whole function. It compiles and
  // lints today only because nothing here touches the DOM — the next line that
  // reaches for `window.matchMedia` would silently get a `NamedWindow | null`.
  const named = namedWindow(context?.contextWindow, context?.thresholdSource, denominator);
  return (
    <div className="context-pop" role="dialog" aria-label="Context usage">
      <span className="eyebrow">Context</span>
      <p className="context-line tabular">
        {formatTokens(lastInputTokens)} of{" "}
        {gauge.windowOf === null ? formatTokens(denominator.value) : formatWindow(denominator.value)}{" "}
        {scaleName(gauge)} ({shownPct}%)
      </p>
      {gauge.compactsAt !== null && (
        <p className="context-compacts tabular">compacts at {formatTokens(gauge.compactsAt)}</p>
      )}
      {aiCredits !== undefined && aiCredits !== null && (
        <p className="context-credits tabular">
          {t(lang, "ctx.credits", { credits: formatCredits(aiCredits, lang) })}
        </p>
      )}
      {named !== null && (
        <p className="context-window tabular">
          {named.of === "loaded" ? "loaded " : named.of === "published" ? "model " : ""}window ·{" "}
          {formatWindow(named.tokens)}
        </p>
      )}
      {onWindowOverride !== undefined && (
        <WindowOverrideRow
          lang={lang}
          draft={draft}
          onDraft={setDraft}
          active={activeWindow}
          onSet={(tokens) => {
            onWindowOverride(tokens);
            setDraft("");
          }}
          onClear={() => {
            onWindowOverride(null);
            setDraft("");
          }}
        />
      )}
      {context !== null ? (
        <>
          <div className="context-parts">
            <span className="head">part</span>
            <span className="head num">chars</span>
            <span className="head num">~tokens</span>
            {context.parts.map((part, i) => (
              <Fragment key={i}>
                <span className="context-part-label">{part.label}</span>
                <span className="num tabular">{formatTokens(part.chars)}</span>
                <span className="num tabular">{formatTokens(part.estTokens)}</span>
              </Fragment>
            ))}
          </div>
          <p className="context-meta tabular">
            messages: {context.messages} &middot; turn: {context.turn}
          </p>
          <p className="context-note">char/4 estimate — the usage line is the truth</p>
        </>
      ) : (
        <p className="context-note">
          Live introspection (context_info) is additive — the ring uses the last usage event.
        </p>
      )}
    </div>
  );
}

/**
 * What the headline's denominator is: the window, or the compaction point.
 *
 * A window with a provenance is named with it. A window without one comes
 * only from `contextDenominator`'s second tier (no positive threshold on the
 * frame) and is called a window. Every other divisor is a compaction point:
 * a threshold the run or its operator stated, or the web's
 * `FALLBACK_THRESHOLD` when the frame states neither a threshold nor a window.
 */
function scaleName(gauge: ContextGauge): string {
  if (gauge.windowOf === "loaded") return "loaded window";
  if (gauge.windowOf === "published") return "model window";
  if (gauge.windowOf === "set") return "set window";
  return gauge.denominator.of === "window" ? "of the window" : "before compaction";
}

/**
 * The popover's row for the window of this session (card 390).
 *
 * Hook-free on purpose: the popover owns the draft and the language, and this
 * component only draws them and wires the two buttons, so a test can build the
 * element and call its handlers without a DOM. The server decides what may be
 * set; `parseWindowDraft` mirrors its range, and `set` is off for any draft the
 * server would refuse.
 */
export function WindowOverrideRow(props: {
  lang: Lang;
  /** What the input holds, as typed. */
  draft: string;
  onDraft: (draft: string) => void;
  /** The window set for this session, or null when none is. */
  active: number | null;
  onSet: (tokens: number) => void;
  onClear: () => void;
}) {
  const { lang, draft, active } = props;
  const parsed = parseWindowDraft(draft);
  const send = (): void => {
    if (parsed !== null) props.onSet(parsed);
  };
  return (
    <div className="context-override">
      <label className="context-override-label" htmlFor="context-window-override">
        {t(lang, "ctx.window.label")}
      </label>
      {active !== null && (
        <p className="context-override-on tabular">
          {t(lang, "ctx.window.active", { window: formatWindow(active) })}
        </p>
      )}
      <div className="context-override-row">
        <input
          id="context-window-override"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t(lang, "ctx.window.placeholder")}
          aria-describedby="context-window-override-range"
          className="context-override-input tabular"
          value={draft}
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button type="button" className="context-override-apply" disabled={parsed === null} onClick={send}>
          {t(lang, "ctx.window.set")}
        </button>
        <button
          type="button"
          className="context-override-clear"
          disabled={active === null}
          onClick={props.onClear}
        >
          {t(lang, "ctx.window.clear")}
        </button>
      </div>
      <p id="context-window-override-range" className="context-override-range">
        {t(lang, "ctx.window.range", {
          floor: formatWindow(WINDOW_OVERRIDE_FLOOR),
          ceiling: formatWindow(WINDOW_OVERRIDE_CEILING),
        })}
      </p>
    </div>
  );
}

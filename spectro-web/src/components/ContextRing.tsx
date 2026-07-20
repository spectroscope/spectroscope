// Claude-Code-style context gauge: a small donut in the header showing how
// full the model's context window is. The value is usage truth — the last
// reported inputTokens of the main agent — against the compaction threshold.
// The popover adds the char/4 introspection when the harness emits
// context_info (an additive extra); without it the ring still works.

import { Fragment, useEffect, useRef, useState } from "react";
import type { ContextSnapshot } from "../state/reducer";
import { formatTokens } from "../format";

const SIZE = 18;
const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;
const FALLBACK_THRESHOLD = 100000;
// Gauge tones — deliberately mirrors the CLI gauge's thresholds.
const WARM_AT_PCT = 70;
const CRITICAL_AT_PCT = 90;

export function ContextRing(props: {
  lastInputTokens: number;
  context: ContextSnapshot | null;
}) {
  const { lastInputTokens, context } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const threshold = context?.threshold ?? FALLBACK_THRESHOLD;
  const pct = threshold > 0 ? (lastInputTokens / threshold) * 100 : 0;
  const shownPct = Math.round(pct);
  const frac = Math.max(0, Math.min(1, pct / 100));
  // Status colors are decorative here (the percent label carries the value);
  // the thresholds mirror the CLI gauge: calm, warming, critical.
  const tone = pct < WARM_AT_PCT ? "var(--ok)" : pct <= CRITICAL_AT_PCT ? "var(--warn)" : "var(--error)";

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
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="var(--border)"
            strokeWidth="2.5"
          />
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
        </svg>
        <span className="tabular">{shownPct}%</span>
      </button>

      {open && (
        <div className="context-pop" role="dialog" aria-label="Context usage">
          <span className="eyebrow">Context</span>
          <p className="context-line tabular">
            {formatTokens(lastInputTokens)} of {formatTokens(threshold)} tokens ({shownPct}%)
          </p>
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
              Live introspection (context_info) is additive — the ring uses the last
              usage event.
            </p>
          )}
        </div>
      )}
    </span>
  );
}

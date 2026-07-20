// The JSONL strip of the Lab: applied lines above, the just-fired line
// highlighted, then the dam divider and the queued lines dimmed below. Every
// row expands to the full event via the existing JsonTree. Windowed rendering
// keeps long sessions cheap.

import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "../events";
import { JsonTree } from "../components/JsonTree";
import { SummaryLine, TEXT_FIELD_EVENTS } from "../components/eventSummary";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

const APPLIED_WINDOW = 200;
const QUEUE_WINDOW = 50;
// Summary preview widths (mirror the CLI's *_PREVIEW_CHARS naming).
const LONG_PREVIEW_CHARS = 60;
const SHORT_PREVIEW_CHARS = 40;

/** One line of human summary per event type — the trace stays scannable. */
function summarize(event: RunEvent): string {
  switch (event.type) {
    case "run_start":
      return event.prompt.slice(0, LONG_PREVIEW_CHARS);
    case "turn_start":
      return `turn ${event.turn}`;
    case "text_delta":
    case "thinking_delta":
      return JSON.stringify(event.text.slice(0, SHORT_PREVIEW_CHARS));
    case "tool_call":
    case "permission_request":
      return event.name;
    case "permission_decision":
      return event.allowed ? "allowed" : "denied";
    case "tool_result":
      return `${event.isError ? "ERROR " : ""}${event.output.slice(0, SHORT_PREVIEW_CHARS)} · ${event.durationMs} ms`;
    case "usage":
      return `${event.inputTokens} in / ${event.outputTokens} out`;
    case "run_end":
      return event.stopReason;
    case "error":
      return event.message.slice(0, LONG_PREVIEW_CHARS);
    case "agent_spawn":
      return `${event.agentId} · ${event.task.slice(0, SHORT_PREVIEW_CHARS)}`;
    case "image_generated":
      return `${event.provider} · ${event.model}`;
    case "compaction":
      return `${event.removedTurns} turns → summary`;
    case "context_info":
      return `~${event.estimatedTokens} tokens`;
    case "agent_message":
      return `${event.from} → ${event.to} · ${event.state}${event.label ? ` (${event.label})` : ""} · ${JSON.stringify(event.text.slice(0, SHORT_PREVIEW_CHARS))}`;
    default:
      return "";
  }
}

function Row({
  event,
  seq,
  variant,
  refCallback,
}: {
  event: RunEvent;
  seq: number;
  variant: "applied" | "current" | "queued";
  refCallback?: (el: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div ref={refCallback} className={`lab-line lab-line--${variant}`}>
      <button type="button" className="lab-line-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lab-line-seq tabular">{seq}</span>
        <span className="lab-line-type mono">{event.type}</span>
        <span className="lab-line-sum">
          <SummaryLine text={summarize(event)} field={TEXT_FIELD_EVENTS.has(event.type) ? "text" : undefined} />
        </span>
      </button>
      {open && (
        <div className="lab-line-body">
          <JsonTree value={event} defaultDepth={1} rootLabel={event.type} />
        </div>
      )}
    </div>
  );
}

export function LabTrace({
  applied,
  queue,
  fireSeq,
}: {
  applied: RunEvent[];
  queue: RunEvent[];
  fireSeq: number;
}) {
  const currentRef = useRef<HTMLDivElement | null>(null);
  const lang = useLang();
  // "Alle": drop the render windows and show every line — a couple of
  // thousand plain rows are fine; the windows are only the calm default.
  const [showAll, setShowAll] = useState(false);

  // Follow the just-fired line (nearest keeps the dam divider in view too).
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [fireSeq]);

  const appliedStart = showAll ? 0 : Math.max(0, applied.length - APPLIED_WINDOW);
  const shownApplied = applied.slice(appliedStart);
  const shownQueue = showAll ? queue : queue.slice(0, QUEUE_WINDOW);

  return (
    <aside className="lab-trace" aria-label="JSONL trace">
      <div className="lab-trace-head">
        <span className="eyebrow sand">JSONL</span>
        <button
          type="button"
          className={`lab-trace-all${showAll ? " lab-trace-all--on" : ""}`}
          aria-pressed={showAll}
          title={t(lang, "lab.allTitle")}
          onClick={() => setShowAll((a) => !a)}
        >
          {t(lang, "lab.all")}
        </button>
        <span className="lab-trace-meta tabular">
          {t(lang, "lt.meta", { a: applied.length, q: queue.length })}
        </span>
      </div>
      <div className="lab-trace-scroll">
        {appliedStart > 0 && <div className="lab-line lab-line--gap">{t(lang, "lt.earlier", { n: appliedStart })}</div>}
        {shownApplied.map((event, i) => {
          const seq = appliedStart + i + 1;
          const isCurrent = appliedStart + i === applied.length - 1;
          return (
            <Row
              key={`a${seq}`}
              event={event}
              seq={seq}
              variant={isCurrent ? "current" : "applied"}
              refCallback={isCurrent ? (el) => (currentRef.current = el) : undefined}
            />
          );
        })}
        <div className="lab-dam" role="separator" aria-label="dam">
          <span className="lab-dam-line" />
          <span className="lab-dam-label mono">{t(lang, "lt.dam", { n: queue.length })}</span>
          <span className="lab-dam-line" />
        </div>
        {shownQueue.map((event, i) => (
          <Row key={`q${applied.length + i + 1}`} event={event} seq={applied.length + i + 1} variant="queued" />
        ))}
        {queue.length > shownQueue.length && (
          <div className="lab-line lab-line--gap">{t(lang, "lt.moreWaiting", { n: queue.length - shownQueue.length })}</div>
        )}
      </div>
    </aside>
  );
}

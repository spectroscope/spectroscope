// The Text tab — the fourth lens on the same event stream: the whole session
// as READABLE TEXT with the protocol made visible (literal <think>/</think>
// markers, [tool_call …] indicators, the gate, run boundaries), plus a raw
// JSONL view that shows the session exactly as the file on disk stores it —
// one line per wire event. Both render the same events the chat/graph/trace
// fold; the heavy lifting is the pure textFeed module.

import { useMemo, useState } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildTextFeed, eventsToJsonl, feedToPlainText } from "../state/textFeed";
import { CopyButton } from "./CopyButton";

type TextMode = "text" | "jsonl";

/** The mode survives tab switches and reloads — same pattern as the graph toggle. */
const MODE_STORAGE_KEY = "spectroscope.textView.mode";

function storedMode(): TextMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === "jsonl" ? "jsonl" : "text";
  } catch {
    return "text";
  }
}

export function TextView({ events }: { events: readonly RunEvent[] }) {
  const lang = useLang();
  const [mode, setMode] = useState<TextMode>(storedMode);

  const pick = (next: TextMode): void => {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // private mode: the toggle simply does not stick
    }
  };

  const feed = useMemo(() => buildTextFeed(events), [events]);
  const jsonl = useMemo(() => (mode === "jsonl" ? eventsToJsonl(events) : []), [events, mode]);

  return (
    <div className="textview" data-reveal>
      <div className="textview-bar">
        <div className="lab-seg" role="group" aria-label={t(lang, "tf.modeAria")}>
          <button
            type="button"
            className={mode === "text" ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
            aria-pressed={mode === "text"}
            title={t(lang, "tf.modeTextTitle")}
            onClick={() => pick("text")}
          >
            Text
          </button>
          <button
            type="button"
            className={mode === "jsonl" ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
            aria-pressed={mode === "jsonl"}
            title={t(lang, "tf.modeJsonlTitle")}
            onClick={() => pick("jsonl")}
          >
            JSONL
          </button>
        </div>
        <span className="textview-note">
          {mode === "jsonl"
            ? t(lang, "tf.jsonlNote", { n: jsonl.length })
            : t(lang, "tf.textNote")}
        </span>
        <CopyButton
          text={() => (mode === "jsonl" ? jsonl.join("\n") : feedToPlainText(feed))}
        />
      </div>

      {events.length === 0 ? (
        <p className="textview-empty">{t(lang, "tf.empty")}</p>
      ) : mode === "jsonl" ? (
        <div className="textview-scroll">
          <pre className="tf-jsonl">
            {jsonl.map((line, i) => (
              <div key={i} className="tf-jsonl-line">
                {line}
              </div>
            ))}
          </pre>
        </div>
      ) : (
        <div className="textview-scroll">
          <div className="tf-feed">
            {feed.map((s, i) => (
              <div key={i} className={`tf tf--${s.kind}`}>
                {s.agentId !== "main" && s.agentId !== "" && (
                  <span className="tf-agent">[{s.agentId}]</span>
                )}
                {s.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

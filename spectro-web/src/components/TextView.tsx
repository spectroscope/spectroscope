// The Text tab — the fourth lens on the same event stream: the whole session
// as READABLE TEXT with the protocol made visible (literal <think>/</think>
// markers, [tool_call …] indicators, the gate, run boundaries), plus a raw
// JSONL view that shows the session exactly as the file on disk stores it —
// one line per wire event. Both render the same events the chat/graph/trace
// fold; the heavy lifting is the pure textFeed module.
//
// Card 62 adds the LLM-backed EXPLAIN on top of the same feed: a bounded
// digest goes to POST /api/explain and the model's reading streams into a
// panel above the feed — honestly labeled as an interpretation of the
// recorded run. The deterministic gates panel in the trace tab is untouched.

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildExplainDigest, parseNdjsonChunk } from "../state/explainStream";
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

/** The explain panel's whole lifecycle in one value. */
interface ExplainState {
  status: "idle" | "streaming" | "done" | "stopped" | "error";
  text: string;
  meta: { provider: string; model: string } | null;
  error: string | null;
}

const EXPLAIN_IDLE: ExplainState = { status: "idle", text: "", meta: null, error: null };

export function TextView({
  events,
  explainReady = true,
}: {
  events: readonly RunEvent[];
  /** False when the current provider needs a key — the button says why. */
  explainReady?: boolean;
}) {
  const lang = useLang();
  const [mode, setMode] = useState<TextMode>(storedMode);
  const [explain, setExplain] = useState<ExplainState>(EXPLAIN_IDLE);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the tab mid-stream must not leak the fetch.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pick = (next: TextMode): void => {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // private mode: the toggle simply does not stick
    }
  };

  const startExplain = async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setExplain({ status: "streaming", text: "", meta: null, error: null });
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: buildExplainDigest(events), lang }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let message = `HTTP ${res.status}`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // no JSON body — keep the status text
        }
        setExplain({ status: "error", text: "", meta: null, error: message });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseNdjsonChunk(pending, decoder.decode(value, { stream: true }));
        pending = parsed.pending;
        for (const msg of parsed.messages) {
          if (msg.meta) {
            const meta = msg.meta;
            setExplain((s) => ({ ...s, meta }));
          } else if (msg.delta) {
            const delta = msg.delta;
            setExplain((s) => ({ ...s, text: s.text + delta }));
          } else if (msg.error) {
            const error = msg.error;
            setExplain((s) => ({ ...s, status: "error", error }));
            return;
          } else if (msg.done) {
            setExplain((s) => ({ ...s, status: "done" }));
            return;
          }
        }
      }
      // The stream ended without a terminal line — treat it as done, honestly.
      setExplain((s) => (s.status === "streaming" ? { ...s, status: "done" } : s));
    } catch (failed) {
      if (controller.signal.aborted) {
        setExplain((s) => ({ ...s, status: "stopped" }));
        return;
      }
      const message = failed instanceof Error ? failed.message : String(failed);
      setExplain((s) => ({ ...s, status: "error", error: message }));
    }
  };

  const stopExplain = (): void => abortRef.current?.abort();
  const closeExplain = (): void => {
    abortRef.current?.abort();
    setExplain(EXPLAIN_IDLE);
  };

  // Owner 2026-07-26 ("wollen wir nicht auch ehrlich sein"): the reading feed
  // leaves frames out — extended shows the WHOLE record, including the
  // assembled request (system prompt + tool schemas) and the token truth.
  const [extended, setExtended] = useState(false);
  const feed = useMemo(() => buildTextFeed(events, extended), [events, extended]);
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
          {mode === "jsonl" ? t(lang, "tf.jsonlNote", { n: jsonl.length }) : t(lang, "tf.textNote")}
        </span>
        {mode === "text" && (
          <button
            type="button"
            className={extended ? "trace-lens mono trace-lens--on" : "trace-lens mono"}
            aria-pressed={extended}
            title={t(lang, "tf.extendedTitle")}
            onClick={() => setExtended((v) => !v)}
          >
            {t(lang, "tf.extended")}
          </button>
        )}
        <button
          type="button"
          className={explain.status === "streaming" ? "trace-lens mono trace-lens--on" : "trace-lens mono"}
          disabled={events.length === 0 || !explainReady || explain.status === "streaming"}
          title={explainReady ? t(lang, "tf.explainTitle") : t(lang, "tf.explainNeedsProvider")}
          onClick={() => void startExplain()}
        >
          {t(lang, "tf.explain")}
        </button>
        <CopyButton text={() => (mode === "jsonl" ? jsonl.join("\n") : feedToPlainText(feed))} />
      </div>

      {explain.status !== "idle" && (
        <div className="tf-explain" role="region" aria-label={t(lang, "tf.explain")}>
          <div className="tf-explain-head">
            <span className="tf-explain-title mono">{t(lang, "tf.explain")}</span>
            {explain.meta && (
              <span className="tf-explain-model mono">
                {explain.meta.provider} · {explain.meta.model}
              </span>
            )}
            <span className="tf-explain-honesty">{t(lang, "tf.explainHonesty")}</span>
            {explain.status === "streaming" ? (
              <button type="button" className="trace-lens mono" onClick={stopExplain}>
                {t(lang, "tf.explainStop")}
              </button>
            ) : (
              explain.text !== "" && <CopyButton text={() => explain.text} />
            )}
            <button
              type="button"
              className="trace-lens mono"
              title={t(lang, "tf.explainClose")}
              onClick={closeExplain}
            >
              ×
            </button>
          </div>
          <div className="tf-explain-body">
            {explain.text === "" && explain.status === "streaming" ? (
              <span className="tf-explain-working">{t(lang, "tf.explainWorking")}</span>
            ) : (
              explain.text
            )}
            {explain.status === "streaming" && explain.text !== "" && (
              <span className="tf-explain-cursor">▋</span>
            )}
          </div>
          {explain.status === "stopped" && (
            <div className="tf-explain-foot">{t(lang, "tf.explainStopped")}</div>
          )}
          {explain.status === "error" && (
            <div className="tf-explain-foot tf-explain-foot--error">
              {t(lang, "tf.explainFailed", { msg: explain.error ?? "?" })}
            </div>
          )}
        </div>
      )}

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
                {s.agentId !== "main" && s.agentId !== "" && <span className="tf-agent">[{s.agentId}]</span>}
                {s.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

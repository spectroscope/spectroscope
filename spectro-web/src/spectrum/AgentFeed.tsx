// Variant A (0.7 A/B): one agent's activity as a readable feed — the chat
// tab's face while an agent tab is focused. Read-only plus the honest
// composer mock (the wire has no message verb yet).

import { useEffect, useMemo, useRef } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { eventPreview } from "./eventPreview";

const KIND_VAR: Record<string, string> = {
  thinking_delta: "--ev-reasoning",
  text_delta: "--ev-token",
  tool_call: "--ev-tool",
  tool_result: "--ev-tool",
  permission_request: "--ev-gate",
  permission_decision: "--ev-gate",
  agent_spawn: "--ev-subagent",
  agent_message: "--ev-subagent",
  run_start: "--ev-lifecycle",
  run_end: "--ev-lifecycle",
  error: "--error",
};

function ownsEvent(event: RunEvent, agentId: string): boolean {
  return "agentId" in event && (event as { agentId?: unknown }).agentId === agentId;
}

export function AgentFeed({ agentId, events }: { agentId: string; events: RunEvent[] }) {
  const lang = useLang();
  const mine = useMemo(() => events.filter((e) => ownsEvent(e, agentId)), [events, agentId]);
  const t0 = useMemo(() => {
    const first = mine.find((e) => typeof (e as { ts?: unknown }).ts === "number");
    return first !== undefined ? (first as { ts: number }).ts : null;
  }, [mine]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [mine.length]);
  return (
    <div className="agent-feed">
      <div className="agent-feed-scroll">
        {mine.length === 0 && <p className="agent-feed-empty">{t(lang, "bus.feedEmpty")}</p>}
        {mine.map((e, i) => {
          const p = eventPreview(e);
          const ts = typeof (e as { ts?: unknown }).ts === "number" ? (e as { ts: number }).ts : null;
          const rel = ts !== null && t0 !== null ? `+${((ts - t0) / 1000).toFixed(1)}s` : "";
          return (
            <div key={i} className="agent-feed-row">
              <span
                className="agent-feed-dot"
                style={{ background: `var(${KIND_VAR[e.type] ?? "--ev-lifecycle"})` }}
                aria-hidden="true"
              />
              <span className="agent-feed-time mono tabular">{rel}</span>
              <span className="agent-feed-type mono">{p.type}</span>
              <span className="agent-feed-detail">{p.detail}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="agent-feed-composer">
        <input
          type="text"
          className="mono"
          placeholder={t(lang, "bus.composerPlaceholder")}
          disabled
          title={t(lang, "bus.composerPending")}
        />
        <button type="button" disabled title={t(lang, "bus.composerPending")}>
          →
        </button>
      </div>
    </div>
  );
}

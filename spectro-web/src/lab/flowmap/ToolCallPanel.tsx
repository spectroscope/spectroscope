// The map's tool-call panel (card 120), on the agent card and the MCP
// station: one call in flight, readable in two faces. Insight is the JSON
// tree the panel always showed (the JSONL-first default); structured renders
// the call as the thing it is — a command in a terminal, an edit as its
// before/after — through ToolViewBody, the chat card's renderer. The strip
// mirrors the JSONL rows' (LabTrace); the master above the map re-faces every
// open panel, and a strip pick wins until the next master move retires it
// (labFace.ts, owner decision 2026-07-30).

import { useState } from "react";
import { JsonTree } from "../../components/JsonTree";
import { ToolViewBody } from "../../components/ToolViewBody";
import {
  LAB_FACES,
  panelFace,
  useLabFace,
  type LabFace,
  type LabFacePref,
  type PanelFace,
} from "../../state/labFace";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";

/** One strip click: this panel takes the picked face until the master moves
 *  again — the stamp carries the epoch it was made under (faceStore.ts). */
export function pickPanelFace(master: LabFacePref, face: LabFace): PanelFace {
  return { face, epoch: master.epoch };
}

export function ToolCallPanel({ tool }: { tool: { name: string; input: unknown } }) {
  const lang = useLang();
  const master = useLabFace();
  const [override, setOverride] = useState<PanelFace | null>(null);
  const face = panelFace(master, override);
  return (
    <div className="pf-panelbox">
      <div className="pf-panelbox__label">
        {t(lang, "map.ctx.toolCall")} · {tool.name}
      </div>
      <div className="trace-detail-modes" role="group" aria-label={t(lang, "trace.modeAria")}>
        {LAB_FACES.map((f) => (
          <button
            key={f}
            type="button"
            className="nodrag"
            aria-pressed={face === f}
            title={t(lang, `lab.faceTitle.${f}`)}
            onClick={() => setOverride(pickPanelFace(master, f))}
          >
            {t(lang, `trace.mode.${f}`)}
          </button>
        ))}
      </div>
      {/* 240 since card 287 — the widened stations and worker cards afford a
          panel a person can actually read; it scrolls either way. */}
      <div className="nowheel" style={{ maxHeight: 240, overflow: "auto" }}>
        {face === "structured" ? (
          /* No output on purpose: sceneToFlow clears the tool on tool_result,
             so the panel only ever holds a pending call. */
          <ToolViewBody
            mode="structured"
            name={tool.name}
            input={tool.input}
            isError={false}
            denied={false}
          />
        ) : (
          <JsonTree value={tool.input} defaultDepth={3} />
        )}
      </div>
    </div>
  );
}

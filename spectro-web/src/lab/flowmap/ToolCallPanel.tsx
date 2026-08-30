// The map's tool-call panel (card 120), on the agent card and the MCP
// station: one call, readable in two faces. On the agent card it is a call in
// flight; on the MCP station it is the call that card is asking, which since
// card 328 outlives its answer. Insight is the JSON
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

/**
 * The panel body's cap. 240 since card 287 — the widened stations and worker
 * cards afford a panel a person can actually read; it scrolls either way.
 *
 * Card 319 makes the same number a FLOOR as well, on the budgeted agent hub
 * only, so a call starting cannot grow the card and its answer cannot shrink
 * it. That half is a `height` in flowmap.css beside every other reserve rather
 * than a second literal here, and `.pf-toolbody` is the hook it hangs off.
 */
const TOOL_BODY = { maxHeight: 240, overflow: "auto" } as const;

export function ToolCallPanel({
  tool,
}: {
  /** The call in flight, or null — the panel then holds its box and says the
   *  agent is planning. Null only ever reaches here from a budgeted card. */
  tool: { name: string; input: unknown } | null;
}) {
  const lang = useLang();
  const master = useLabFace();
  const [override, setOverride] = useState<PanelFace | null>(null);
  const face = panelFace(master, override);
  return (
    <div className="pf-panelbox">
      {/* The title carries the name whole. On the budgeted agent card this label
          is held to one line — a second line moved the card 15.5px, the only
          thing still moving it after the reserves landed — and card 296 already
          settled what a cap owes the reader when it clipped the worker card's
          task title: keep the cap, and put the text somewhere it can be read. */}
      <div className="pf-panelbox__label" title={tool === null ? undefined : tool.name}>
        {t(lang, "map.ctx.toolCall")}
        {tool === null ? "" : ` · ${tool.name}`}
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
      {/* The 240 lives in TOOL_BODY as a maxHeight and in `.pf-agent--wide
          .pf-toolbody` as a height. That is not a duplicate: the compact card
          is capped and the wide one RESERVES, because a capped box still
          collapses when it is empty and everything under it moves. Promoting
          the inline cap to a height is the change that makes a red merge green
          and is wrong — cardStillness pins it. */}
      <div className="nowheel pf-toolbody" style={TOOL_BODY}>
        {tool === null ? (
          <div className="pf-kv">{t(lang, "map.ctx.noTool")}</div>
        ) : face === "structured" ? (
          /* No output on purpose, and card 328 changed WHY. The old reason
             was that sceneToFlow cleared the tool on tool_result, so the panel
             could only ever hold a pending call — that stopped being true the
             moment the MCP client card started holding its call past the
             answer, and it is now fed calls that have already been answered.
             The reason it still renders no output is the design: this panel is
             the ASKING half of an exchange. What came back is the MCP-Server
             card's half, across the boundary the map draws, and printing it
             here as well would make two cards say one thing. */
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

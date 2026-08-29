// Card 306: the frame a workflow run gets in the lab map, in its own module.
//
// React Flow takes this component through the map's node-type map, never
// through JSX — exactly the shape the component-reach drift gate cannot tell
// from an orphan while the card and the map share one file. Card 293 split
// `WorkflowNode` out for the same reason; this follows it.

import { type NodeProps } from "@xyflow/react";
import { Handles } from "./handles";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";

/** One phase band, as the box draws it. Every number is the pure geometry's,
 *  so the frame and the cards inside it can never drift apart. */
interface WfBoxBand {
  title: string;
  detail: string | null;
  unplaced: boolean;
  y: number;
  h: number;
  count: number;
}

/**
 * CARD 306: the frame a workflow run gets in the lab map.
 *
 * It draws NO agents. The agents are React Flow child nodes seated by
 * `workflowBoxLayout` — they are the cards they already were — and this is the
 * frame around them: the run's name and progress at the top, and one band per
 * declared phase behind them, so the stages are visible and the reader can see
 * which phase holds five.
 *
 * The bands are positioned from the SAME numbers the members were seated from,
 * in the same frame of reference: `workflowBoxLayout` measures everything from
 * the box's own top-left, and so does an absolutely positioned child of
 * `.pf-wfbox`. Reading a band's top out of CSS instead would be a second
 * geometry, free to disagree with the first, and a band drawn half a card off
 * is exactly the kind of wrongness that looks like a design choice — which is
 * what it looked like for eight of thirteen cards until
 * `workflowBoxNode.test.tsx` started comparing the two rectangles.
 */
export function WorkflowBoxNode({ data }: NodeProps) {
  const lang = useLang();
  const d = data as {
    boxId: string;
    title: string;
    phasesTotal: number;
    phasesEntered: number;
    agents: number;
    state: string | null;
    stateLabel: string | null;
    stateColor: string | null;
    expanded: boolean;
    bands: WfBoxBand[];
    onToggle?: (boxId: string) => void;
  };
  const toggle = d.onToggle;
  return (
    <div className={`pf-wfbox${d.expanded ? " pf-wfbox--expanded" : ""}`}>
      {/* The same eight every other card carries. A member's leg home targets
          this box on "rt" — the run is what launched it — and React Flow drops
          an edge whose handle does not exist, with a console warning and no
          error. Measured on the shipped scenario before these were here: that
          warning, and no rail from any member to its box anywhere in the
          rendered edge list. That is card 295's floating cards, back. */}
      <Handles />
      <div className="pf-wfbox__head">
        <span className="pf-wfbox__title" title={d.title}>
          {d.stateColor !== null && <span className="pf-wfbox__dot" style={{ background: d.stateColor }} />}
          {d.title}
        </span>
        <span className="pf-wfbox__facts">
          <span className="pf-badge tabular">
            {d.phasesEntered}/{d.phasesTotal} {t(lang, "map.wf.phases")}
          </span>
          <span className="pf-badge tabular">
            {d.agents} {t(lang, "map.wf.agents")}
          </span>
          {d.stateLabel !== null && (
            <span className="pf-badge" style={{ color: d.stateColor ?? undefined }}>
              {d.stateLabel}
            </span>
          )}
        </span>
        {toggle !== undefined && (
          <button
            type="button"
            className="pf-wfbox__switch nodrag"
            data-box={d.boxId}
            title={t(lang, d.expanded ? "map.wf.collapse" : "map.wf.expand")}
            onClick={(e) => {
              e.stopPropagation();
              toggle(d.boxId);
            }}
          >
            {t(lang, d.expanded ? "map.wf.collapse" : "map.wf.expand")}
          </button>
        )}
      </div>
      {d.bands.map((b, i) => (
        <div
          key={`${b.title}-${i}`}
          className={`pf-wfband${b.unplaced ? " pf-wfband--unplaced" : ""}${
            b.count === 0 ? " pf-wfband--empty" : ""
          }`}
          // The band's own coordinates ARE the members' coordinates: both are
          // measured from the frame's top-left, and both already carry the
          // header. `.pf-wfbox` is the positioned ancestor and the header is
          // static, so nothing displaces this element — subtracting the header
          // here drew every band 46px above the agents it holds, and every
          // card landed on the next phase's title.
          style={{ top: `${b.y}px`, height: `${b.h}px` }}
        >
          <span className="pf-wfband__label" title={b.detail ?? undefined}>
            {b.title}
            {b.count === 0 && <em className="pf-wfband__note">{t(lang, "map.wf.empty")}</em>}
          </span>
        </div>
      ))}
    </div>
  );
}

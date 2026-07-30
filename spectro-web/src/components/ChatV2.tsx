// Chat v2 (branch chat-v2, PROTOTYPE): the same transcript, read differently.
// The main agent's own line of thought on the left, and everything running
// alongside it in the panel on the right.
//
// This is a SIBLING of Chat, not a fork of it. The concept's work order asked
// for a copy so that a v2 bug could not reach v1; a copy would have duplicated
// seven hundred lines of composer, footer, search, translation, export, tool
// cards and scroll pinning, and the reuse rule outranks the isolation rule. So
// Chat gained exactly two optional props with v1 defaults (`grouping`,
// `renderChip`), and everything v2 actually IS lives here: the chip, the
// selection, and the fold that feeds the panel.
//
// What the chip does NOT do, on purpose: it does not show a child's denial.
// Whether a summary may stay neutral while the work behind it was refused is an
// owner call (concept section 8, call 4), and a prototype must not answer it by
// accident. The panel carries the denial, loudly.

import { useMemo } from "react";
import type { ComponentProps, CSSProperties } from "react";
import { Chat } from "./Chat";
import type { WorkItem } from "../state/work";
import { elapsedLabel, tokenLabel } from "./workLevels";
import { agentAccent } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

type ChatProps = ComponentProps<typeof Chat>;

/** Flatten the tree so a chip can find any work item by id. */
function index(items: WorkItem[], into = new Map<string, WorkItem>()): Map<string, WorkItem> {
  for (const item of items) {
    into.set(item.id, item);
    index(item.children, into);
  }
  return into;
}

export function ChatV2(
  props: ChatProps & {
    /** The SAME fold the panel renders — App folds once and hands it to both,
     *  so a chip and its row can never disagree about the run they describe. */
    work: WorkItem[];
    onOpenWork?: (workId: string) => void;
  },
) {
  const lang = useLang();
  const byId = useMemo(() => index(props.work), [props.work]);

  return (
    <Chat
      {...props}
      grouping="v2"
      renderChip={(workIds) => (
        <div className="work-chip" role="group">
          {workIds.map((id) => {
            const item = byId.get(id);
            const span = item === undefined ? null : elapsedLabel(item.firstTs, item.lastTs);
            return (
              <button
                key={id}
                type="button"
                className={`work-chip-btn${item !== undefined ? ` work-chip-btn--${item.state}` : ""}`}
                style={{ "--agent-color": agentAccent(id) } as CSSProperties}
                title={t(lang, "work.chipOpen")}
                onClick={() => props.onOpenWork?.(id)}
              >
                <span className="work-chip-dot" aria-hidden="true" />
                <span className="mono">{item?.name ?? id}</span>
                {/* Only what the fold measured. An item the fold never saw
                    (a turn whose agent left no other frame) shows its id and
                    nothing else, rather than a row of zeros. */}
                {item !== undefined && item.inTokens + item.outTokens > 0 && (
                  <span className="tabular">{tokenLabel(item.inTokens + item.outTokens)}</span>
                )}
                {span !== null && <span className="tabular">{span}</span>}
              </button>
            );
          })}
        </div>
      )}
    />
  );
}

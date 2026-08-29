// The work panel (branch chat-v2, PROTOTYPE): concurrent work beside the
// transcript, three levels deep — group, item, child. The right column of the
// owner's screenshot, fed by the same RunEvent[] the chat folds from.
//
// The rule this file exists to keep: THE PANEL RENDERS NO NUMBER IT CANNOT TAKE
// YOU TO. Every figure below is either a button carrying the frame that produced
// it (App's onFocusEvent seam, already built for Spectrum and the fleet canvas)
// or it is not drawn. Counts a background task REPORTED about work outside this
// stream are quoted as claims and get no rows underneath, because there are
// none — see konzept/CHAT-V2.md section 4.3.

import { useState } from "react";
import type { CSSProperties } from "react";
import type { RunEvent } from "../events";
import type { WorkItem } from "../state/work";
import { absences, besideReading, elapsedLabel, tokenLabel, workGroups } from "./workLevels";
import type { SidecarAgent, SidecarIndex } from "../import/sidecarAgents";
import { NO_SIDECARS } from "../import/sidecarAgents";
import type { AgentInfo } from "../state/reducer";
import { createContext, useContext } from "react";

/**
 * The agents beside the imported session, and how to open one (card 177), plus
 * the roster the agents panel renders (card 313).
 *
 * A context rather than five more props: the rows nest (group → item → child),
 * and this evidence belongs to the whole panel, not to a row's own shape. The
 * default is the empty index and an empty roster, so every caller that knows
 * nothing about either — the lab, a test that only wants the rows — reads
 * exactly as it did before both cards.
 */
const BesideContext = createContext<{
  sidecars: SidecarIndex;
  roster: readonly AgentInfo[];
  onOpenAgent?: (agent: SidecarAgent) => void;
}>({ sidecars: NO_SIDECARS, roster: [] });
import type { WorkGroup } from "./workLevels";
import { agentAccent, clockTime } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** A figure with a frame behind it: a button into the trace. Without one it is
 *  plain text, so a reader can tell by clicking what the stream actually holds. */
function Fig({
  event,
  agentId,
  onFocus,
  title,
  children,
}: {
  event: RunEvent | null;
  agentId: string;
  onFocus?: (agentId: string, event: RunEvent) => void;
  title: string;
  children: React.ReactNode;
}) {
  const lang = useLang();
  if (event === null || onFocus === undefined)
    return (
      <span className="work-fig work-fig--dead" title={t(lang, "work.noTrace")}>
        {children}
      </span>
    );
  return (
    <button type="button" className="work-fig" title={title} onClick={() => onFocus(agentId, event)}>
      {children}
    </button>
  );
}

function ItemRow({
  item,
  depth,
  highlight,
  onFocus,
}: {
  item: WorkItem;
  depth: number;
  highlight: string | null;
  onFocus?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const span = elapsedLabel(item.firstTs, item.lastTs);
  const toTrace = t(lang, "work.toTrace");
  // Card 177 asked where this launch's agents are; card 313 makes it ONE
  // question with one answer, read off the agents panel's own roster before
  // the disk is consulted at all. Everything this row says about work that is
  // not here hangs off that single reading, including the absences line — two
  // conditions were how the panel came to contradict the panel beside it.
  const { sidecars, roster, onOpenAgent } = useContext(BesideContext);
  const reading = besideReading(item, roster, sidecars);
  const missing = absences(item, reading?.kind === "inStream");

  return (
    <li
      className={`work-item work-item--${item.state}${highlight === item.id ? " work-item--lit" : ""}`}
      style={{ "--agent-color": agentAccent(item.id), "--work-depth": depth } as CSSProperties}
      id={`work-${item.id}`}
    >
      <div className="work-item-head">
        <span className={`agent-dot agent-dot--${item.state}`} aria-hidden="true" />
        <Fig event={item.evidence.start} agentId={item.id} onFocus={onFocus} title={toTrace}>
          <span className="work-item-name mono">{item.name}</span>
        </Fig>
        {item.name !== item.id && <span className="work-item-id mono">{item.id}</span>}
        <span className={`agent-badge agent-badge--${item.state}`}>{t(lang, `map.life.${item.state}`)}</span>
      </div>

      {item.intent !== "" && <div className="work-item-intent">{item.intent}</div>}
      {item.lastStatus !== null && <div className="work-item-status">» {item.lastStatus}</div>}

      <div className="work-item-meta mono tabular">
        {item.inTokens + item.outTokens > 0 && (
          <Fig event={item.evidence.tokens} agentId={item.id} onFocus={onFocus} title={toTrace}>
            {tokenLabel(item.inTokens)} in · {tokenLabel(item.outTokens)} out
          </Fig>
        )}
        {item.toolCalls > 0 && (
          <Fig event={item.evidence.firstCall} agentId={item.id} onFocus={onFocus} title={toTrace}>
            {t(lang, "work.calls", { n: item.toolCalls })}
          </Fig>
        )}
        {/* The span is a figure like any other: it opens at the item's LAST
            frame, which is where "it took this long" is settled. */}
        {span !== null ? (
          <Fig event={item.evidence.end} agentId={item.id} onFocus={onFocus} title={toTrace}>
            {span}
          </Fig>
        ) : (
          <span className="work-fig work-fig--dead">{t(lang, "work.noSpan")}</span>
        )}
        {item.firstTs !== null && item.lastTs !== null && (
          <span className="work-clock">
            {clockTime(item.firstTs)} → {clockTime(item.lastTs)}
          </span>
        )}
        {item.model !== null && <span className="work-model">{item.model}</span>}
      </div>

      {/* Permission decisions: the thing the screenshotted tool has no record
          of at all. A denial is its own mark, never a red error. */}
      {(item.gatesAsked > 0 || item.gatePending) && (
        <div className="work-gates">
          <span className="work-gate">{t(lang, "work.gates", { n: item.gatesAsked })}</span>
          {item.gatesDenied > 0 && (
            <Fig event={item.evidence.denial} agentId={item.id} onFocus={onFocus} title={toTrace}>
              <span className="work-gate work-gate--denied">
                {t(lang, "work.denied", { n: item.gatesDenied })}
              </span>
            </Fig>
          )}
          {item.gatePending && (
            <span className="work-gate work-gate--pending">{t(lang, "work.gatePending")}</span>
          )}
        </div>
      )}

      {/* Card 313: the agents ARE here. They are listed as agents under this
          row, so nothing is named as a file and no byte size is printed — the
          agents panel and this one are reading one roster. The claim keeps its
          place only where it disagrees with what is loaded, because a run that
          reported four and brought three has said something a reader wants. */}
      {reading?.kind === "inStream" && (
        <div className="work-beside">
          <p className="work-beside-head">
            {t(lang, reading.agents.length === 1 ? "work.inStreamOne" : "work.inStream", {
              n: reading.agents.length,
            })}
            {reading.claimed !== null && reading.claimed !== reading.agents.length && (
              <span className="work-beside-off">
                {" "}
                · {t(lang, "work.besideClaim", { n: reading.claimed })}
              </span>
            )}
          </p>
        </div>
      )}
      {/* The agents are NOT in the stream, and their transcripts sit beside
          the session (card 177): each one openable, and named as the file it
          still is. */}
      {reading?.kind === "files" && (
        <div className="work-beside">
          <p className="work-beside-head">
            {t(lang, "work.beside", { n: reading.files.length })}
            {reading.claimed !== null && reading.claimed !== reading.files.length && (
              <span className="work-beside-off">
                {" "}
                · {t(lang, "work.besideClaim", { n: reading.claimed })}
              </span>
            )}
          </p>
          <ul className="work-beside-list">
            {reading.files.map((a) => (
              <li key={a.path}>
                <button
                  type="button"
                  className="work-beside-row"
                  title={a.path}
                  onClick={() => onOpenAgent?.(a)}
                  disabled={onOpenAgent === undefined}
                >
                  <span className="mono work-beside-id">{a.agentId}</span>
                  <span className="work-beside-size">{Math.max(1, Math.round(a.bytes / 1024))} kB</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Neither: what the task CLAIMS about work that is nowhere on this
          machine — quoted, never drawn, because there is nothing to draw. The
          refusal is not softened, and it is still the honest reading of a
          session imported without its sidecars. */}
      {reading?.kind === "claim" && (
        <div className="work-opaque">
          <span>{t(lang, "work.opaque", { n: reading.claimed })}</span>
          {reading.toolUses !== null && <span>{t(lang, "work.opaqueCalls", { n: reading.toolUses })}</span>}
        </div>
      )}

      {missing.length > 0 && (
        <div className="work-missing">
          {t(lang, "work.missing", { what: missing.map((m) => t(lang, `work.miss.${m}`)).join(", ") })}
        </div>
      )}

      {item.children.length > 0 && (
        <>
          <button
            type="button"
            className="work-toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {t(lang, "work.agentsN", { n: item.children.length })}
          </button>
          {open && (
            <ul className="work-children">
              {item.children.map((c) => (
                <ItemRow key={c.id} item={c} depth={depth + 1} highlight={highlight} onFocus={onFocus} />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function GroupCard({
  group,
  highlight,
  onFocus,
}: {
  group: WorkGroup;
  highlight: string | null;
  onFocus?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const lit = group.items.some((i) => i.id === highlight);
  const [open, setOpen] = useState(true);
  const span = elapsedLabel(group.firstTs, group.lastTs);
  return (
    <section className={`work-group work-group--${group.state}${lit ? " work-group--lit" : ""}`}>
      <button
        type="button"
        className="work-group-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="work-group-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className={`agent-dot agent-dot--${group.state}`} aria-hidden="true" />
        <span className="work-group-name">{group.label ?? t(lang, `work.kind.${group.kind}`)}</span>
        <span className="work-group-kind">{t(lang, `work.kind.${group.kind}`)}</span>
      </button>
      <div className="work-group-meta mono tabular">
        <span>{t(lang, "work.done", { k: group.done, n: group.total })}</span>
        {span !== null && <span>{span}</span>}
        {group.toolCalls > 0 && <span>{t(lang, "work.calls", { n: group.toolCalls })}</span>}
        {group.inTokens + group.outTokens > 0 && (
          <span>
            {tokenLabel(group.inTokens)} in · {tokenLabel(group.outTokens)} out
          </span>
        )}
        {group.gatesDenied > 0 && (
          <span className="work-gate work-gate--denied">
            {t(lang, "work.denied", { n: group.gatesDenied })}
          </span>
        )}
      </div>
      {/* Progress squares: one per member, filled when it settled. Nothing is
          interpolated — a running member is a hollow square, not a bar that
          guesses how far along it is. */}
      <div className="work-squares" aria-hidden="true">
        {group.items.map((i) => (
          <span
            key={i.id}
            className={`work-square work-square--${i.state}${i.gatePending ? " work-square--gate" : ""}`}
          />
        ))}
      </div>
      {open && (
        <ul className="work-items">
          {group.items.map((i) => (
            <ItemRow key={i.id} item={i} depth={0} highlight={highlight} onFocus={onFocus} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorkPanel({
  items,
  liveView,
  highlight,
  onFocusEvent,
  sidecars,
  roster,
  onOpenAgent,
}: {
  items: WorkItem[];
  liveView: boolean;
  /** The agents beside the imported session, when it has any (card 177). */
  sidecars?: SidecarIndex;
  /**
   * The roster the AGENTS PANEL renders, verbatim (card 313).
   *
   * Not a copy and not a second fold: this panel and that one answer "is this
   * agent here" out of the same array, which is the whole repair. Omitted, the
   * empty roster says nothing is loaded — the reading the panel had before
   * card 297 could load anything.
   */
  roster?: readonly AgentInfo[];
  /** Open one of them as a session in its own right. */
  onOpenAgent?: (agent: SidecarAgent) => void;
  /** The work id the transcript's chip points at, so the panel can light it. */
  highlight?: string | null;
  /** The SAME seam Spectrum and FleetCanvas use (App.tsx:1261-1279). */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const groups = workGroups(items);

  if (groups.length === 0) {
    return (
      <div className="work-empty">
        <p>{t(lang, liveView ? "work.emptyLive" : "work.empty")}</p>
        {/* The absence that matters most, said out loud rather than left as a
            blank panel: detached work exists on the wire and not in any file
            this prototype can open. */}
        <p className="work-empty-note">{t(lang, "work.triggerNone")}</p>
      </div>
    );
  }

  return (
    <BesideContext.Provider value={{ sidecars: sidecars ?? NO_SIDECARS, roster: roster ?? [], onOpenAgent }}>
      <div className="work-panel">
        {groups.map((g) => (
          <GroupCard key={g.id} group={g} highlight={highlight ?? null} onFocus={onFocusEvent} />
        ))}
        {!groups.some((g) => g.kind === "trigger") && (
          <p className="work-empty-note">{t(lang, "work.triggerNone")}</p>
        )}
      </div>
    </BesideContext.Provider>
  );
}

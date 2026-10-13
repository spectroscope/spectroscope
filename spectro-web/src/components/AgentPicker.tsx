// Card 593: one picker over the agents of the session, used by the ring's
// popover, the Plan panel and the System context panel. The label says what
// is shown; the list is a listbox the arrows walk. The stateful half is thin
// and the view is hook-free, so a test can press its handlers without a DOM.

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { AgentPick, ShownAgent } from "../state/shownAgent";
import { dismissesMenu, MODAL_LAYER } from "./menuDismiss";
import { pickerKey, pickerRows, type PickerRow, type PickerState } from "./agentPickerModel";

export type PickerKeyEvent = { key: string; preventDefault: () => void; stopPropagation: () => void };

export function AgentPicker({ agents, shown, onPick }: AgentPick) {
  const lang = useLang();
  const rows = pickerRows(agents, shown);
  const shownAt = Math.max(
    0,
    rows.findIndex((r) => (r.id ?? shown.rootId) === shown.id),
  );
  const [held, setState] = useState<PickerState>({ open: false, index: shownAt });
  // The roster can shrink under an open list (a session switch); the active row stays inside it.
  const state: PickerState = { ...held, index: Math.min(held.index, rows.length - 1) };
  const ref = useRef<HTMLDivElement>(null);
  const idBase = useId();

  // An outside press closes the list; a press inside a modal above it does not.
  useEffect(() => {
    if (!held.open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      const inAnchor = ref.current?.contains(target) ?? false;
      const inModal = target instanceof Element && target.closest(MODAL_LAYER) !== null;
      if (dismissesMenu({ inAnchor, inModal })) setState((s) => ({ ...s, open: false }));
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [held.open]);

  const onKeyDown = (e: PickerKeyEvent): void => {
    // One agent, nothing to choose: the chevron is disabled, so are the keys.
    if (rows.length <= 1) return;
    const next = pickerKey(state, e.key, rows.length);
    if (next.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    setState(next.state);
    if (next.pick !== null) onPick(rows[next.pick].id);
  };

  return (
    <AgentPickerView
      lang={lang}
      rows={rows}
      shown={shown}
      open={state.open}
      index={state.index}
      idBase={idBase}
      rootRef={ref}
      onToggle={() => setState((s) => ({ open: !s.open, index: shownAt }))}
      onKeyDown={onKeyDown}
      onPickRow={(row) => {
        setState((s) => ({ ...s, open: false }));
        onPick(row.id);
      }}
    />
  );
}

/** The picker as drawn; hook-free. */
export function AgentPickerView(props: {
  lang: Lang;
  rows: PickerRow[];
  shown: ShownAgent;
  open: boolean;
  index: number;
  idBase: string;
  rootRef?: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onKeyDown: (e: PickerKeyEvent) => void;
  onPickRow: (row: PickerRow) => void;
}) {
  const { lang, rows, shown, open, index, idBase } = props;
  const alone = rows.length <= 1;
  const name = shown.isRoot ? t(lang, "pick.main") : shown.id;
  const rowId = (i: number): string => `${idBase}-${i}`;
  return (
    <div
      className={`agent-pick${open ? " agent-pick--open" : ""}`}
      ref={props.rootRef}
      onKeyDown={props.onKeyDown}
    >
      <button
        type="button"
        className="agent-pick-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={alone ? true : undefined}
        aria-label={t(lang, "pick.aria")}
        aria-activedescendant={open ? rowId(index) : undefined}
        onClick={alone ? undefined : props.onToggle}
      >
        <span className="agent-pick-showing">{t(lang, "pick.showing", { name })}</span>
        <span className="agent-pick-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {shown.missing !== null && (
        <p className="agent-pick-missing">{t(lang, "pick.missing", { id: shown.missing })}</p>
      )}
      {open && (
        <ul className="agent-pick-list" role="listbox" aria-label={t(lang, "pick.aria")}>
          {rows.map((row, i) => {
            const selected = row.id === null ? shown.isRoot : row.id === shown.id;
            return (
              <li
                key={row.key}
                id={rowId(i)}
                role="option"
                aria-selected={selected}
                className={`agent-pick-row${i === index ? " agent-pick-row--active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onPickRow(row)}
              >
                {row.working && row.state !== null && (
                  <span className={`agent-dot agent-dot--${row.state}`} aria-hidden="true" />
                )}
                <span className="agent-pick-name mono">
                  {row.id === null ? t(lang, "pick.main") : row.id}
                </span>
                {row.label !== null && <span className="agent-pick-label">{row.label}</span>}
                {row.task !== "" && <span className="agent-pick-task">{row.task}</span>}
                {row.ended && <span className="agent-pick-ended">{t(lang, "pick.ended")}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Card 593: the picker's rows and keys, pure, so a test can drive them without a DOM.
import type { AgentInfo } from "../state/reducer";
import type { ShownAgent } from "../state/shownAgent";
import { nextMenuIndex } from "../panels/headerPanelControls";

/** How many characters of a helper's task a row shows. */
export const TASK_CLIP = 40;

export interface PickerRow {
  key: string;
  /** The helper's id, or null for the root row. */
  id: string | null;
  label: string | null;
  task: string;
  state: AgentInfo["state"] | null;
  working: boolean;
  ended: boolean;
}

export function clipTask(task: string): string {
  return task.length <= TASK_CLIP ? task : task.slice(0, TASK_CLIP) + "…";
}

/** The root first, then every roster row with a parent, in roster order. Parentless rows that are not the root (session-title) are left out. */
export function pickerRows(agents: readonly AgentInfo[], shown: ShownAgent): PickerRow[] {
  const rows: PickerRow[] = [
    { key: shown.rootId, id: null, label: null, task: "", state: null, working: false, ended: false },
  ];
  for (const a of agents) {
    if (a.parentId === null) continue;
    rows.push({
      key: a.id,
      id: a.id,
      label: a.label,
      task: clipTask(a.task),
      state: a.state,
      working: a.state === "submitted" || a.state === "working",
      ended: a.state === "completed" || a.state === "failed",
    });
  }
  return rows;
}

export interface PickerState {
  open: boolean;
  index: number;
}

export interface PickerKey {
  state: PickerState;
  /** The row to pick, by index, or null. */
  pick: number | null;
  /** True when the picker consumed the key; the caller then stops its propagation. */
  handled: boolean;
}

/** What a key does to the picker. Escape with the list closed is left alone on purpose: the popover's own listener closes on it. */
export function pickerKey(state: PickerState, key: string, count: number): PickerKey {
  if (!state.open) {
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
      return { state: { open: true, index: state.index }, pick: null, handled: true };
    }
    return { state, pick: null, handled: false };
  }
  if (key === "Escape") return { state: { open: false, index: state.index }, pick: null, handled: true };
  if (key === "Enter" || key === " ")
    return { state: { open: false, index: state.index }, pick: state.index, handled: true };
  if (key === "Tab") return { state: { open: false, index: state.index }, pick: null, handled: false };
  const moves = key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
  return { state: { open: true, index: nextMenuIndex(state.index, key, count) }, pick: null, handled: moves };
}

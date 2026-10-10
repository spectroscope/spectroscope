// Card 483: the toolbar of the playbook editor. What it offers is a pure
// function of the store's state (`toolbarModel`); the component only reads the
// model and sends the click to the store. The toolbar carries the class
// `nokey`, so Backspace in a control never deletes the selection.

import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import {
  dispatch,
  loadView,
  redoEdit,
  revertEdit,
  saveEdit,
  undoEdit,
  useEditorState,
  type EditorState,
} from "../../state/playbookEditor";
import { canRedo, canUndo } from "./history";

export type ToolbarStatus = "saved" | "unsaved" | "checking" | "refused" | "changed" | "failed";

export interface ToolbarModel {
  canAddAfter: boolean;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSave: boolean;
  canRevert: boolean;
  status: ToolbarStatus;
}

/**
 * What the toolbar offers for a state of the store.
 *
 * `canAddAfter` is true for a selected step or decision and for a selected
 * arrow, the two things a new node can follow; an end has nothing after it and
 * with nothing selected there is no place to add after. `canSave` leaves the
 * decision on findings to the server, which refuses a save while any exist.
 *
 * @param s the editor state
 * @return the model
 */
export function toolbarModel(s: EditorState): ToolbarModel {
  const doc = s.history?.present ?? null;
  const sel = s.selection;
  const node = sel?.kind === "node" && doc !== null ? doc.nodes.find((n) => n.id === sel.id) : undefined;
  const canAddAfter =
    sel !== null && doc !== null && (sel.kind === "arrow" || (node !== undefined && node.kind !== "end"));
  let status: ToolbarStatus;
  if (s.save.kind === "refused" || s.save.kind === "changed" || s.save.kind === "failed") {
    status = s.save.kind;
  } else if (s.sentSeq > s.viewSeq) {
    status = "checking";
  } else {
    status = s.dirty ? "unsaved" : "saved";
  }
  return {
    canAddAfter,
    canDelete: sel !== null,
    canUndo: s.history !== null && canUndo(s.history),
    canRedo: s.history !== null && canRedo(s.history),
    canSave: s.dirty && s.save.kind !== "saving",
    canRevert: s.dirty,
    status,
  };
}

export function EditorToolbar() {
  const lang = useLang();
  const s = useEditorState();
  const m = toolbarModel(s);

  const add = (nodeKind: "step" | "decision" | "end"): void =>
    dispatch({ kind: "add", nodeKind, after: s.selection });
  const remove = (): void => {
    const sel = s.selection;
    if (sel === null) return;
    dispatch(
      sel.kind === "node" ? { kind: "deleteNode", id: sel.id } : { kind: "deleteArrow", key: sel.key },
    );
  };
  // A revert also reads the file again: after a 409 the base hash is the old
  // one, and only a fresh read lets the next save through.
  const revert = (): void => {
    const dir = s.dir;
    const workspace = s.workspace;
    revertEdit();
    if (dir !== null) loadView(dir, workspace).catch(() => undefined);
  };

  const button = (key: string, enabled: boolean, onClick: () => void, extra = "") => (
    <button type="button" className={`pbe-btn${extra}`} disabled={!enabled} onClick={onClick}>
      {t(lang, key)}
    </button>
  );

  let state: string;
  switch (m.status) {
    case "refused":
      state = t(lang, "pbe.state.refused", { n: s.save.kind === "refused" ? s.save.findings.length : 0 });
      break;
    case "failed":
      state = t(lang, "pbe.state.failed", { message: s.save.kind === "failed" ? s.save.message : "" });
      break;
    default:
      state = t(lang, `pbe.state.${m.status}`);
  }

  return (
    <div className="pbe-toolbar nokey" role="toolbar">
      <div className="pbe-toolbar-group">
        {button("pbe.addStep", m.canAddAfter, () => add("step"))}
        {button("pbe.addDecision", m.canAddAfter, () => add("decision"))}
        {button("pbe.addEnd", m.canAddAfter, () => add("end"))}
        {button("pbe.delete", m.canDelete, remove)}
      </div>
      <div className="pbe-toolbar-group">
        {button("pbe.undo", m.canUndo, undoEdit)}
        {button("pbe.redo", m.canRedo, redoEdit)}
      </div>
      <div className="pbe-toolbar-group">
        {button("pbe.save", m.canSave, () => void saveEdit(), " pbe-btn--primary")}
        {button("pbe.revert", m.canRevert, revert)}
      </div>
      <span className={`pbe-state pbe-state--${m.status}`} role="status">
        {state}
      </span>
    </div>
  );
}

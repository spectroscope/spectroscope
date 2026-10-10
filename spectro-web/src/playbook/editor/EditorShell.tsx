// Card 483: the edit layout of the playbook segment: the toolbar on top, the
// canvas and the side panels under it. Below 720 px the panels stack under the
// canvas (styles/playbook-editor.css). Nothing here holds state; the store
// above the pane does.

import { EditorCanvas } from "./EditorCanvas";
import { EditorToolbar } from "./EditorToolbar";
import { EditorPanels } from "./panels/EditorPanels";

export function EditorShell() {
  return (
    <div className="pbe-shell">
      <EditorToolbar />
      <div className="pbe-body">
        <div className="pbe-stage">
          <EditorCanvas />
        </div>
        <aside className="pbe-side">
          <EditorPanels />
        </aside>
      </div>
    </div>
  );
}

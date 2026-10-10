// Card 483: the panels over the store. Three tabs (the selection, the document
// types, the checks) and the findings of the newest draft check under them.
// The panels themselves take props; this is the one place that reads the store
// and the installed skills.

import { useState } from "react";
import { t } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";
import { dispatch, select, useEditorState } from "../../../state/playbookEditor";
import { useSkills } from "../../../state/skillList";
import { ChecksPanel } from "./ChecksPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { FindingsList } from "./FindingsList";
import { SelectionPanel } from "./SelectionPanel";

type Tab = "selection" | "documents" | "checks";
const TABS: Tab[] = ["selection", "documents", "checks"];

export function EditorPanels() {
  const lang = useLang();
  const s = useEditorState();
  const skills = useSkills(true);
  const [tab, setTab] = useState<Tab>("selection");
  const doc = s.history?.present ?? null;
  if (doc === null) return null;
  // A refused save names its own list; otherwise the newest draft check does.
  const findings = s.save.kind === "refused" ? s.save.findings : (s.view?.loaded.findings ?? []);
  return (
    <div className="pbe-panels">
      <div className="pbe-tabs" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`pbe-tab${tab === k ? " is-active" : ""}`}
            onClick={() => setTab(k)}
          >
            {t(lang, `pbe.tab.${k}`)}
          </button>
        ))}
      </div>
      {tab === "selection" && (
        <SelectionPanel
          doc={doc}
          selection={s.selection}
          choices={s.view?.choices ?? []}
          skills={skills}
          refused={s.refused}
          dispatch={dispatch}
        />
      )}
      {tab === "documents" && <DocumentsPanel doc={doc} refused={s.refused} dispatch={dispatch} />}
      {tab === "checks" && <ChecksPanel doc={doc} refused={s.refused} dispatch={dispatch} />}
      <FindingsList
        doc={doc}
        findings={findings}
        onPick={(sel) => {
          select(sel);
          setTab("selection");
        }}
      />
    </div>
  );
}

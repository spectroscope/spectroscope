// Card 483: the document types of the playbook, one row each, and the parts
// of the file this version shows but does not edit (models, vars, contents).

import { t } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";
import type { Command } from "../commands";
import type { DocDocumentType, PlaybookDoc } from "../doc";
import { splitLines } from "../options";
import { AddRow, Field, Refusal, TextField } from "./fields";

export function DocumentsPanel({
  doc,
  refused,
  dispatch,
}: {
  doc: PlaybookDoc;
  refused: string | null;
  dispatch: (cmd: Command) => void;
}) {
  const lang = useLang();
  const put = (id: string, value: DocDocumentType) => dispatch({ kind: "putDocument", id, value });
  return (
    <div className="pbe-panel nokey">
      {Object.entries(doc.documents).map(([id, d]) => (
        <section className="pbe-card" data-document={id} key={id}>
          <Field field="id">
            <TextField value={id} onCommit={(to) => dispatch({ kind: "renameDocument", from: id, to })} />
          </Field>
          <Field field="name">
            <TextField value={d.name} onCommit={(name) => put(id, { ...d, name })} />
          </Field>
          <Field field="purpose">
            <TextField value={d.purpose} onCommit={(purpose) => put(id, { ...d, purpose })} />
          </Field>
          <Field field="location">
            <TextField value={d.location} onCommit={(location) => put(id, { ...d, location })} />
          </Field>
          <Field field="template">
            <TextField
              value={d.template ?? ""}
              onCommit={(template) => put(id, { ...d, template: template === "" ? undefined : template })}
            />
          </Field>
          <Field field="sections">
            <TextField
              multiline
              value={d.sections.join("\n")}
              onCommit={(text) => put(id, { ...d, sections: splitLines(text) })}
            />
          </Field>
          <button type="button" className="pbe-btn" onClick={() => dispatch({ kind: "deleteDocument", id })}>
            {t(lang, "pbe.remove")}
          </button>
        </section>
      ))}
      <AddRow
        placeholder={t(lang, "pbe.field.id")}
        onAdd={(id) => {
          if (id in doc.documents) return false;
          put(id, { name: id, purpose: "", location: "", sections: [] });
          return true;
        }}
      />
      <Refusal reason={refused} />
      <ReadOnlyParts doc={doc} />
    </div>
  );
}

/** Model choices, vars and contents as the file has them; the editor changes none of them. */
function ReadOnlyParts({ doc }: { doc: PlaybookDoc }) {
  const lang = useLang();
  const contents = Object.entries(doc.contents).filter(([, names]) => names.length > 0);
  return (
    <section className="pbe-readonly" data-readonly>
      <p className="pbe-note">{t(lang, "pbe.readOnlyParts")}</p>
      <ul className="pbe-mono">
        {Object.entries(doc.models).map(([choice, m]) => (
          <li key={`model:${choice}`}>
            {choice}: {m.primary.provider} {m.primary.model}
            {m.fallbacks.length > 0 && ` (+${m.fallbacks.length})`}
          </li>
        ))}
        {Object.entries(doc.vars).map(([k, v]) => (
          <li key={`var:${k}`}>
            {k} = {v}
          </li>
        ))}
        {contents.map(([kind, names]) => (
          <li key={`content:${kind}`}>
            {kind}: {names.join(", ")}
          </li>
        ))}
      </ul>
    </section>
  );
}

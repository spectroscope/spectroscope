// Card 483: the checks of the playbook, one row each. A kind shows only the
// fields it uses (CHECK_FIELDS), the same list the command drops stale fields by.

import { t } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";
import type { Command } from "../commands";
import type { DocCheck, PlaybookDoc } from "../doc";
import { CHECK_FIELDS, splitLines } from "../options";
import { AddRow, Field, Group, MultiCheck, Refusal, SelectField, TextField } from "./fields";

export function ChecksPanel({
  doc,
  refused,
  dispatch,
}: {
  doc: PlaybookDoc;
  refused: string | null;
  dispatch: (cmd: Command) => void;
}) {
  const lang = useLang();
  const put = (id: string, value: DocCheck) => dispatch({ kind: "putCheck", id, value });
  return (
    <div className="pbe-panel nokey">
      {Object.entries(doc.checks).map(([id, c]) => (
        <section className="pbe-card" data-check={id} key={id}>
          <Field field="id">
            <TextField value={id} onCommit={(to) => dispatch({ kind: "renameCheck", from: id, to })} />
          </Field>
          <Field field="kind">
            <SelectField
              value={c.kind}
              options={Object.keys(CHECK_FIELDS).map((k) => ({ value: k, label: k }))}
              onChange={(kind) => put(id, { ...c, kind })}
            />
          </Field>
          {(CHECK_FIELDS[c.kind] ?? []).map((f) => (
            <CheckField key={f} name={f} check={c} doc={doc} onChange={(next) => put(id, next)} />
          ))}
          <button type="button" className="pbe-btn" onClick={() => dispatch({ kind: "deleteCheck", id })}>
            {t(lang, "pbe.remove")}
          </button>
        </section>
      ))}
      <AddRow
        placeholder={t(lang, "pbe.field.id")}
        onAdd={(id) => {
          if (id in doc.checks) return false;
          put(id, { kind: "sections" });
          return true;
        }}
      />
      <Refusal reason={refused} />
    </div>
  );
}

function CheckField({
  name,
  check,
  doc,
  onChange,
}: {
  name: keyof DocCheck;
  check: DocCheck;
  doc: PlaybookDoc;
  onChange: (next: DocCheck) => void;
}) {
  const lang = useLang();
  const docOptions = Object.entries(doc.documents).map(([value, d]) => ({ value, label: d.name || value }));
  switch (name) {
    case "documents":
    case "reads":
      return (
        <Group field={name}>
          <MultiCheck
            options={docOptions}
            selected={check[name] ?? []}
            onChange={(next) => onChange({ ...check, [name]: next })}
          />
        </Group>
      );
    case "forbid":
    case "labels":
      return (
        <Field field={name}>
          <TextField
            multiline
            value={(check[name] ?? []).join("\n")}
            onCommit={(text) => onChange({ ...check, [name]: splitLines(text) })}
          />
        </Field>
      );
    case "model":
      return (
        <Field field="model">
          <SelectField
            value={check.model ?? ""}
            options={[
              { value: "", label: t(lang, "pbe.none") },
              ...Object.keys(doc.models).map((m) => ({ value: m, label: m })),
            ]}
            onChange={(model) => onChange({ ...check, model: model === "" ? undefined : model })}
          />
        </Field>
      );
    case "run":
    case "ask":
      return (
        <Field field={name}>
          <TextField
            value={check[name] ?? ""}
            onCommit={(text) => onChange({ ...check, [name]: text === "" ? undefined : text })}
          />
        </Field>
      );
    default:
      return null;
  }
}

// Card 483: the small controls every panel is built from. A text field keeps
// its typing in component state and commits once, on blur or Enter; a select
// or a checkbox commits at once. Escape puts the stored value back.

import { useState, type ReactNode } from "react";
import { t } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";

/** A label over a control. `field` is the key of `pbe.field.*` and the `data-field` the tests read. */
export function Field({ field, children }: { field: string; children: ReactNode }) {
  const lang = useLang();
  return (
    <label className="pbe-field" data-field={field}>
      <span className="pbe-field-label">{t(lang, `pbe.field.${field}`)}</span>
      {children}
    </label>
  );
}

/** A group of controls under a legend, for the fields that hold a list. */
export function Group({ field, children }: { field: string; children: ReactNode }) {
  const lang = useLang();
  return (
    <fieldset className="pbe-field pbe-group" data-field={field}>
      <legend className="pbe-field-label">{t(lang, `pbe.field.${field}`)}</legend>
      {children}
    </fieldset>
  );
}

/**
 * A text input. The typing stays here; `onCommit` runs on blur or Enter with
 * the text, and only when it differs from the stored value.
 */
export function TextField({
  value,
  onCommit,
  placeholder,
  readOnly,
  multiline,
  numeric,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  multiline?: boolean;
  numeric?: boolean;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  // A new stored value (another selection, an undo) replaces what was typed.
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  const commit = () => {
    if (!readOnly && text !== value) onCommit(text);
  };
  if (multiline) {
    return (
      <textarea
        className="pbe-input"
        value={text}
        rows={3}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") setText(value);
        }}
      />
    );
  }
  return (
    <input
      className="pbe-input"
      type="text"
      inputMode={numeric ? "numeric" : undefined}
      value={text}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(value);
      }}
    />
  );
}

export interface Option {
  value: string;
  label: string;
  title?: string;
}

/** A select that dispatches at once. A stored value that is not among the options is kept as one. */
export function SelectField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const all = options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
  return (
    <select className="pbe-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {all.map((o) => (
        <option key={o.value} value={o.value} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** One checkbox per option; the new list keeps the order the ticks were made in. */
export function MultiCheck({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string; note?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const known = new Set(options.map((o) => o.value));
  const all: { value: string; label: string; note?: string }[] = [
    ...options,
    ...selected.filter((s) => !known.has(s)).map((s) => ({ value: s, label: s })),
  ];
  return (
    <ul className="pbe-checks">
      {all.map((o) => {
        const on = selected.includes(o.value);
        return (
          <li key={o.value}>
            <label>
              <input
                type="checkbox"
                data-option={o.value}
                checked={on}
                onChange={() => onChange(on ? selected.filter((s) => s !== o.value) : [...selected, o.value])}
              />{" "}
              <span className="pbe-mono">{o.label}</span>
              {o.note !== undefined && <span className="pbe-note"> {o.note}</span>}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** A one-line add form: a text input and a button. Local typing; `onAdd` returns false when refused. */
export function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => boolean }) {
  const lang = useLang();
  const [text, setText] = useState("");
  const [taken, setTaken] = useState(false);
  const add = () => {
    const v = text.trim();
    if (v === "") return;
    if (onAdd(v)) {
      setText("");
      setTaken(false);
    } else {
      setTaken(true);
    }
  };
  return (
    <div className="pbe-addrow">
      <input
        className="pbe-input"
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setTaken(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <button type="button" className="pbe-btn" onClick={add}>
        {t(lang, "pbe.add")}
      </button>
      {taken && (
        <span className="pbe-warn" role="alert">
          {t(lang, "pbe.renameTaken")}
        </span>
      )}
    </div>
  );
}

/** The reason a command was refused, by its i18n key, or nothing. */
export function Refusal({ reason }: { reason: string | null }) {
  const lang = useLang();
  if (reason === null) return null;
  return (
    <p className="pbe-warn" role="alert">
      {t(lang, reason)}
    </p>
  );
}

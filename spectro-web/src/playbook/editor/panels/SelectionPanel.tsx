// Card 483: the panel for the selected node or arrow. Every control reports
// one command through `dispatch`; the panel holds no document state of its
// own. The root carries `nokey`, so React Flow ignores Delete and the arrow
// keys while a field has the focus.

import { t, type Lang } from "../../../i18n/i18n";
import { useLang } from "../../../state/lang";
import type { EditorViewWire } from "../../../state/playbookEditor";
import {
  baseOutcomesOf,
  type DocDecision,
  type DocEnd,
  type DocStep,
  type PlaybookDoc,
  type Selection,
} from "../doc";
import { arrowKey } from "../doc";
import type { Command } from "../commands";
import { modelOptions, outcomeOptions, skillOptions } from "../options";
import { AddRow, Field, Group, MultiCheck, Refusal, SelectField, TextField } from "./fields";

export interface SelectionPanelProps {
  doc: PlaybookDoc;
  selection: Selection;
  choices: EditorViewWire["choices"];
  skills: readonly { name: string }[];
  /** The reason key of the last refused command, or null. */
  refused: string | null;
  dispatch: (cmd: Command) => void;
}

const PERMISSIONS = ["inherit", "readonly", "ask", "auto"];

export function SelectionPanel(props: SelectionPanelProps) {
  const lang = useLang();
  const { doc, selection } = props;
  const node = selection?.kind === "node" ? doc.nodes.find((n) => n.id === selection.id) : undefined;
  const arrow =
    selection?.kind === "arrow" ? doc.arrows.find((a) => arrowKey(a) === selection.key) : undefined;

  return (
    <div className="pbe-panel nokey">
      {node?.kind === "step" && <StepFields {...props} node={node} lang={lang} />}
      {node?.kind === "decision" && <DecisionFields {...props} node={node} lang={lang} />}
      {node?.kind === "end" && <EndFields {...props} node={node} />}
      {arrow !== undefined && selection?.kind === "arrow" && <ArrowFields {...props} keyOf={selection.key} />}
      {node === undefined && arrow === undefined && (
        <p className="pbe-empty">{t(lang, "pbe.nothingSelected")}</p>
      )}
      <Refusal reason={props.refused} />
    </div>
  );
}

function Header({ id, doc, dispatch }: Pick<SelectionPanelProps, "doc" | "dispatch"> & { id: string }) {
  const lang = useLang();
  return (
    <>
      <Field field="id">
        <TextField value={id} onCommit={(to) => dispatch({ kind: "renameNode", from: id, to })} />
      </Field>
      {doc.start === id ? (
        <p className="pbe-note">{t(lang, "pbe.isStart")}</p>
      ) : (
        <button type="button" className="pbe-btn" onClick={() => dispatch({ kind: "setStart", id })}>
          {t(lang, "pbe.startHere")}
        </button>
      )}
    </>
  );
}

function StepFields({
  doc,
  node,
  choices,
  skills,
  dispatch,
  lang,
}: SelectionPanelProps & { node: DocStep; lang: Lang }) {
  const edit = (patch: Partial<Omit<DocStep, "kind" | "id">>) =>
    dispatch({ kind: "editStep", id: node.id, patch });
  const models = modelOptions(choices);
  const chosen = choices.find((c) => c.choice === node.model);
  const docOptions = Object.entries(doc.documents).map(([value, d]) => ({ value, label: d.name || value }));
  return (
    <>
      <Header id={node.id} doc={doc} dispatch={dispatch} />
      <Field field="name">
        <TextField value={node.name} onCommit={(name) => edit({ name })} />
      </Field>
      <Field field="goal">
        <TextField
          multiline
          value={node.goal ?? ""}
          onCommit={(goal) => edit({ goal: goal === "" ? undefined : goal })}
        />
      </Field>
      <Field field="performer">
        <SelectField
          value={node.performer}
          options={[
            { value: "chat", label: t(lang, "pb.chat") },
            { value: "child", label: t(lang, "pb.child") },
          ]}
          onChange={(performer) =>
            edit(performer === "chat" ? { performer, role: undefined } : { performer })
          }
        />
      </Field>
      {node.performer === "child" && (
        <Field field="role">
          <TextField
            value={node.role ?? ""}
            onCommit={(role) => edit({ role: role === "" ? undefined : role })}
          />
        </Field>
      )}
      <Group field="skills">
        <MultiCheck
          options={skillOptions(skills, node.skills).map((s) => ({
            value: s.name,
            label: s.name,
            note: s.installed ? undefined : t(lang, "pb.notInstalled"),
          }))}
          selected={node.skills}
          onChange={(next) => edit({ skills: next })}
        />
      </Group>
      <Field field="model">
        <SelectField
          value={node.model ?? ""}
          options={[
            { value: "", label: t(lang, "pbe.none") },
            ...models.map((m) => ({ value: m.value, label: m.label, title: m.reason ?? undefined })),
          ]}
          onChange={(model) => edit({ model: model === "" ? undefined : model })}
        />
        {chosen !== undefined && (
          <span className="pbe-note" title={chosen.reason ?? undefined}>
            {t(lang, "pbe.model.state", { provider: chosen.provider, state: chosen.state })}
          </span>
        )}
      </Field>
      <Field field="privacy">
        <SelectField
          value={node.privacy}
          options={[
            { value: "private", label: t(lang, "pbe.privacy.private") },
            { value: "cheap", label: t(lang, "pbe.privacy.cheap") },
          ]}
          onChange={(privacy) => edit({ privacy })}
        />
      </Field>
      <Field field="permission">
        <SelectField
          value={node.permission}
          options={PERMISSIONS.map((p) => ({ value: p, label: p }))}
          onChange={(permission) => edit({ permission })}
        />
      </Field>
      <Group field="consumes">
        <MultiCheck
          options={docOptions}
          selected={node.consumes}
          onChange={(next) => edit({ consumes: next })}
        />
      </Group>
      <Group field="produces">
        <MultiCheck
          options={docOptions}
          selected={node.produces}
          onChange={(next) => edit({ produces: next })}
        />
      </Group>
      <Field field="nod">
        <input type="checkbox" checked={node.nod} onChange={(e) => edit({ nod: e.target.checked })} />
      </Field>
    </>
  );
}

function DecisionFields({
  doc,
  node,
  dispatch,
  lang,
}: SelectionPanelProps & { node: DocDecision; lang: Lang }) {
  const edit = (patch: Partial<Pick<DocDecision, "name" | "check" | "max_rounds">>) =>
    dispatch({ kind: "editDecision", id: node.id, patch });
  const declared = node.outcomes ?? [];
  return (
    <>
      <Header id={node.id} doc={doc} dispatch={dispatch} />
      <Field field="name">
        <TextField value={node.name} onCommit={(name) => edit({ name })} />
      </Field>
      <Field field="check">
        <SelectField
          value={node.check}
          options={[
            { value: "", label: t(lang, "pbe.none") },
            ...Object.keys(doc.checks).map((c) => ({ value: c, label: c })),
          ]}
          onChange={(check) => edit({ check })}
        />
      </Field>
      <Group field="outcomes">
        {declared.length > 0
          ? declared.map((o) => (
              <div className="pbe-outcome" data-outcome-row key={o}>
                <TextField
                  value={o}
                  onCommit={(to) => dispatch({ kind: "renameOutcome", id: node.id, from: o, to })}
                />
                <button
                  type="button"
                  className="pbe-btn"
                  onClick={() => dispatch({ kind: "removeOutcome", id: node.id, outcome: o })}
                >
                  {t(lang, "pbe.remove")}
                </button>
              </div>
            ))
          : baseOutcomesOf(doc, node).map((label) => (
              <div className="pbe-outcome" data-outcome-row key={label}>
                <input className="pbe-input" type="text" value="" placeholder={label} readOnly />
              </div>
            ))}
        {node.max_rounds !== undefined && (
          <div className="pbe-outcome" data-outcome-row>
            <input className="pbe-input" type="text" value="exhausted" readOnly />
          </div>
        )}
        <AddRow
          placeholder={t(lang, "pbe.field.outcome")}
          onAdd={(outcome) => addOutcome(node, outcome, dispatch)}
        />
      </Group>
      <Field field="maxRounds">
        <TextField
          numeric
          value={node.max_rounds === undefined ? "" : String(node.max_rounds)}
          onCommit={(text) => {
            if (text.trim() === "") return edit({ max_rounds: undefined });
            const n = Number(text);
            if (Number.isInteger(n) && n >= 0) edit({ max_rounds: n });
          }}
        />
      </Field>
    </>
  );
}

/** False when the decision already declares the outcome, so the add row can say so. */
function addOutcome(node: DocDecision, outcome: string, dispatch: (cmd: Command) => void): boolean {
  if ((node.outcomes ?? []).includes(outcome)) return false;
  dispatch({ kind: "addOutcome", id: node.id, outcome });
  return true;
}

function EndFields({ doc, node, dispatch }: SelectionPanelProps & { node: DocEnd }) {
  return (
    <>
      <Header id={node.id} doc={doc} dispatch={dispatch} />
      <Field field="result">
        <TextField
          value={node.result}
          onCommit={(result) => dispatch({ kind: "editEnd", id: node.id, result })}
        />
      </Field>
    </>
  );
}

function ArrowFields({ doc, keyOf, dispatch }: SelectionPanelProps & { keyOf: string }) {
  const lang = useLang();
  const arrow = doc.arrows.find((a) => arrowKey(a) === keyOf);
  if (!arrow) return null;
  const source = doc.nodes.find((n) => n.id === arrow.from);
  const targets = doc.nodes.map((n) => ({
    value: n.id,
    label: `${n.kind === "end" ? n.result : n.name} (${n.id})`,
  }));
  const missing = !doc.nodes.some((n) => n.id === arrow.to);
  const outcomes = outcomeOptions(doc, keyOf);
  return (
    <>
      <Field field="from">
        <span className="pbe-mono">
          {source === undefined
            ? `${arrow.from} ${t(lang, "pbe.ghost.noName")}`
            : `${source.kind === "end" ? source.result : source.name} (${source.id})`}
        </span>
      </Field>
      <Field field="to">
        <SelectField
          value={arrow.to}
          options={
            missing
              ? [...targets, { value: arrow.to, label: `${arrow.to} (${t(lang, "pbe.ghost.missing")})` }]
              : targets
          }
          onChange={(to) => dispatch({ kind: "connect", from: arrow.from, on: arrow.on ?? null, to })}
        />
      </Field>
      {source?.kind === "decision" && (
        <Field field="outcome">
          <SelectField
            value={arrow.on ?? ""}
            options={outcomes.map((o) => ({ value: o, label: o }))}
            onChange={(on) => dispatch({ kind: "setOutcome", key: keyOf, on })}
          />
        </Field>
      )}
    </>
  );
}

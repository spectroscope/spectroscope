// Card 483: the option lists behind the panels. Pure, so each one is tested
// without a render; the panels only draw what these return.

import type { EditorViewWire } from "../../state/playbookEditor";
import { arrowKey, outcomesOf, type PlaybookDoc, type Selection } from "./doc";

/** One list for the command that drops a kind's stale fields and the panel that shows them. */
export { CHECK_FIELDS } from "./commands";

/** The installed skills in their order, then each named skill that is not installed, once. */
export function skillOptions(
  installed: readonly { name: string }[],
  named: string[],
): { name: string; installed: boolean }[] {
  const have = new Set(installed.map((s) => s.name));
  const out = installed.map((s) => ({ name: s.name, installed: true }));
  for (const name of named) {
    if (have.has(name)) continue;
    have.add(name);
    out.push({ name, installed: false });
  }
  return out;
}

/** One option per model choice, with the state card 480 reports for its provider. */
export function modelOptions(
  choices: EditorViewWire["choices"],
): { value: string; label: string; state: string; reason: string | null }[] {
  return choices.map((c) => ({
    value: c.choice,
    label: `${c.choice} (${c.provider} ${c.model})`,
    state: c.state,
    reason: c.reason,
  }));
}

/**
 * The outcomes the arrow can take: those of its source that no other arrow of
 * that source uses, plus its own, in the decision's order. A step's arrow has
 * no outcome, so it gets none.
 */
export function outcomeOptions(doc: PlaybookDoc, key: string): string[] {
  const arrow = doc.arrows.find((a) => arrowKey(a) === key);
  if (!arrow) return [];
  const source = doc.nodes.find((n) => n.id === arrow.from);
  if (source?.kind !== "decision") return [];
  const taken = new Set(
    doc.arrows.filter((a) => a.from === arrow.from && arrowKey(a) !== key).map((a) => a.on ?? ""),
  );
  return outcomesOf(doc, source).filter((o) => !taken.has(o));
}

/** The node or arrow a finding's path points at, or null for any other path. */
export function findingTarget(path: string, doc: PlaybookDoc): Selection {
  const node = /^nodes\[(\d+)\]/.exec(path);
  if (node) {
    const n = doc.nodes[Number(node[1])];
    return n ? { kind: "node", id: n.id } : null;
  }
  const arrow = /^arrows\[(\d+)\]/.exec(path);
  if (arrow) {
    const a = doc.arrows[Number(arrow[1])];
    return a ? { kind: "arrow", key: arrowKey(a) } : null;
  }
  return null;
}

/** One entry per non-empty, trimmed line: how a list field is typed. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

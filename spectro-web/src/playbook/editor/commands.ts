// Card 483: every editor action is one command, a pure function from a
// document to a document. One command is one undo step. A command that has
// nothing to do returns the same document object, so the history records no
// entry; a refused command does the same and names its reason.

import {
  arrowKey,
  outcomesOf,
  type DocArrow,
  type DocCheck,
  type DocDecision,
  type DocDocumentType,
  type DocNode,
  type DocStep,
  type PlaybookDoc,
  type Selection,
} from "./doc";

export type Command =
  | { kind: "add"; nodeKind: "step" | "decision" | "end"; after: Selection }
  | { kind: "connect"; from: string; on: string | null; to: string }
  | { kind: "setOutcome"; key: string; on: string }
  | { kind: "deleteNode"; id: string }
  | { kind: "deleteArrow"; key: string }
  | { kind: "setStart"; id: string }
  | { kind: "renameNode"; from: string; to: string }
  | { kind: "editStep"; id: string; patch: Partial<Omit<DocStep, "kind" | "id">> }
  | { kind: "editDecision"; id: string; patch: Partial<Pick<DocDecision, "name" | "check" | "max_rounds">> }
  | { kind: "editEnd"; id: string; result: string }
  | { kind: "addOutcome"; id: string; outcome: string }
  | { kind: "renameOutcome"; id: string; from: string; to: string }
  | { kind: "removeOutcome"; id: string; outcome: string }
  | { kind: "putDocument"; id: string; value: DocDocumentType }
  | { kind: "renameDocument"; from: string; to: string }
  | { kind: "deleteDocument"; id: string }
  | { kind: "putCheck"; id: string; value: DocCheck }
  | { kind: "renameCheck"; from: string; to: string }
  | { kind: "deleteCheck"; id: string };

export interface Applied {
  doc: PlaybookDoc;
  selection: Selection;
  refused: string | null;
}

/** Default names are file content a team shares, so they are fixed English words. */
export const NEW_NAMES = { step: "New step", decision: "New decision", end: "Done" } as const;

/** The fields each check kind uses besides its kind; a kind change drops the rest. */
const CHECK_FIELDS: Record<string, readonly (keyof DocCheck)[]> = {
  sections: ["documents", "forbid"],
  open_items: ["documents"],
  command: ["run"],
  review: ["model", "reads", "labels"],
  human: ["ask", "labels", "reads"],
};

const TAKEN = "pbe.renameTaken";

/** Pure. A refused command returns the same doc object and a reason key (`pbe.renameTaken`, ...). */
export function apply(doc: PlaybookDoc, selection: Selection, cmd: Command): Applied {
  const same: Applied = { doc, selection, refused: null };
  const refuse = (reason: string): Applied => ({ doc, selection, refused: reason });
  const done = (next: PlaybookDoc, sel: Selection = keep(next, selection)): Applied => ({
    doc: next,
    selection: sel,
    refused: null,
  });

  switch (cmd.kind) {
    case "add":
      return add(doc, cmd.nodeKind, cmd.after);

    case "connect": {
      const on = cmd.on ?? "";
      const i = doc.arrows.findIndex((a) => a.from === cmd.from && (a.on ?? "") === on);
      if (i >= 0) {
        if (doc.arrows[i].to === cmd.to) return same;
        return done({ ...doc, arrows: replaceAt(doc.arrows, i, { ...doc.arrows[i], to: cmd.to }) });
      }
      const arrow: DocArrow = on === "" ? { from: cmd.from, to: cmd.to } : { from: cmd.from, to: cmd.to, on };
      return done({ ...doc, arrows: insertFrom(doc.arrows, cmd.from, arrow) });
    }

    case "setOutcome": {
      const i = arrowIndex(doc, cmd.key);
      if (i < 0) return same;
      const a = doc.arrows[i];
      if ((a.on ?? "") === cmd.on) return same;
      if (doc.arrows.some((b) => b.from === a.from && (b.on ?? "") === cmd.on))
        return refuse("pbe.outcomeTaken");
      const arrows = replaceAt(doc.arrows, i, withOn(a, cmd.on));
      return done({ ...doc, arrows }, follow(doc, arrows, selection));
    }

    case "deleteNode": {
      if (nodeIndex(doc, cmd.id) < 0) return same;
      return done({
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== cmd.id),
        arrows: doc.arrows.filter((a) => a.from !== cmd.id && a.to !== cmd.id),
      });
    }

    case "deleteArrow": {
      const i = arrowIndex(doc, cmd.key);
      if (i < 0) return same;
      return done({ ...doc, arrows: doc.arrows.filter((_, j) => j !== i) });
    }

    case "setStart":
      if (doc.start === cmd.id || nodeIndex(doc, cmd.id) < 0) return same;
      return done({ ...doc, start: cmd.id });

    case "renameNode": {
      const { from, to } = cmd;
      if (to === "" || to === from || nodeIndex(doc, from) < 0) return same;
      if (nodeIndex(doc, to) >= 0) return refuse(TAKEN);
      const rename = (id: string) => (id === from ? to : id);
      const arrows = doc.arrows.map((a) =>
        a.from === from || a.to === from ? { ...a, from: rename(a.from), to: rename(a.to) } : a,
      );
      const next: PlaybookDoc = {
        ...doc,
        start: rename(doc.start),
        nodes: doc.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
        arrows,
      };
      const sel: Selection =
        selection?.kind === "node"
          ? { kind: "node", id: rename(selection.id) }
          : follow(doc, arrows, selection);
      return done(next, sel);
    }

    case "editStep": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "step") return same;
      return done({
        ...doc,
        nodes: replaceAt(doc.nodes, i, defined({ ...n, ...cmd.patch, kind: "step", id: n.id })),
      });
    }

    case "editDecision": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "decision") return same;
      const patched = defined({ ...n, ...cmd.patch, kind: "decision" as const, id: n.id });
      return done({ ...doc, nodes: replaceAt(doc.nodes, i, patched) });
    }

    case "editEnd": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "end" || n.result === cmd.result) return same;
      return done({ ...doc, nodes: replaceAt(doc.nodes, i, { ...n, result: cmd.result }) });
    }

    case "addOutcome": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "decision" || cmd.outcome === "") return same;
      const declared = n.outcomes ?? [];
      if (declared.includes(cmd.outcome)) return refuse(TAKEN);
      return done({ ...doc, nodes: replaceAt(doc.nodes, i, { ...n, outcomes: [...declared, cmd.outcome] }) });
    }

    case "renameOutcome": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "decision") return same;
      const declared = n.outcomes ?? [];
      if (cmd.to === "" || cmd.to === cmd.from || !declared.includes(cmd.from)) return same;
      if (outcomesOf(doc, n).includes(cmd.to)) return refuse(TAKEN);
      const outcomes = declared.map((o) => (o === cmd.from ? cmd.to : o));
      const arrows = doc.arrows.map((a) => (a.from === n.id && a.on === cmd.from ? { ...a, on: cmd.to } : a));
      return done(
        { ...doc, nodes: replaceAt(doc.nodes, i, { ...n, outcomes }), arrows },
        follow(doc, arrows, selection),
      );
    }

    case "removeOutcome": {
      const i = nodeIndex(doc, cmd.id);
      const n = doc.nodes[i];
      if (n?.kind !== "decision" || !(n.outcomes ?? []).includes(cmd.outcome)) return same;
      const outcomes = (n.outcomes ?? []).filter((o) => o !== cmd.outcome);
      const node: DocDecision = { ...n, outcomes };
      if (outcomes.length === 0) delete node.outcomes;
      return done({
        ...doc,
        nodes: replaceAt(doc.nodes, i, node),
        arrows: doc.arrows.filter((a) => !(a.from === n.id && a.on === cmd.outcome)),
      });
    }

    case "putDocument":
      return done({ ...doc, documents: { ...doc.documents, [cmd.id]: defined({ ...cmd.value }) } });

    case "renameDocument": {
      const { from, to } = cmd;
      if (to === "" || to === from || !(from in doc.documents)) return same;
      if (to in doc.documents) return refuse(TAKEN);
      const nodes = doc.nodes.map((n) => {
        if (n.kind !== "step") return n;
        const consumes = swap(n.consumes, from, to);
        const produces = swap(n.produces, from, to);
        return consumes === n.consumes && produces === n.produces ? n : { ...n, consumes, produces };
      });
      const checks = mapValues(doc.checks, (c) => {
        const documents = c.documents && swap(c.documents, from, to);
        const reads = c.reads && swap(c.reads, from, to);
        return documents === c.documents && reads === c.reads ? c : defined({ ...c, documents, reads });
      });
      return done({ ...doc, documents: renameKey(doc.documents, from, to), nodes, checks });
    }

    case "deleteDocument": {
      if (!(cmd.id in doc.documents)) return same;
      return done({ ...doc, documents: withoutKey(doc.documents, cmd.id) });
    }

    case "putCheck": {
      const before = doc.checks[cmd.id];
      let value: DocCheck = defined({ ...cmd.value });
      if (before && before.kind !== value.kind) {
        const used = CHECK_FIELDS[value.kind] ?? [];
        value = Object.fromEntries(
          Object.entries(value).filter(([k]) => k === "kind" || used.includes(k as keyof DocCheck)),
        ) as DocCheck;
      }
      return done({ ...doc, checks: { ...doc.checks, [cmd.id]: value } });
    }

    case "renameCheck": {
      const { from, to } = cmd;
      if (to === "" || to === from || !(from in doc.checks)) return same;
      if (to in doc.checks) return refuse(TAKEN);
      const nodes = doc.nodes.map((n) =>
        n.kind === "decision" && n.check === from ? { ...n, check: to } : n,
      );
      return done({ ...doc, checks: renameKey(doc.checks, from, to), nodes });
    }

    case "deleteCheck": {
      if (!(cmd.id in doc.checks)) return same;
      return done({ ...doc, checks: withoutKey(doc.checks, cmd.id) });
    }

    default: {
      const unknown: never = cmd;
      throw new Error(`unknown command ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * A new node goes into `nodes` right after the selected node, or after the
 * source of a selected arrow, else at the end. On a selected arrow, or on the
 * arrow of a selected step, the new node splits that arrow: the arrow keeps
 * its place and points at the new node, and the new node's own arrow to the
 * old target goes after the source's last arrow (a new decision leaves by its
 * first outcome, a new end by none). On a selected decision the new node takes
 * the first outcome without an arrow. Otherwise it is unconnected.
 */
function add(doc: PlaybookDoc, kind: "step" | "decision" | "end", after: Selection): Applied {
  const id = nextId(doc, kind);
  const node = newNode(kind, id);
  let anchor: string | null = null;
  let split = -1;
  let free: { from: string; on: string } | null = null;

  if (after?.kind === "arrow") {
    split = arrowIndex(doc, after.key);
    if (split >= 0) anchor = doc.arrows[split].from;
  } else if (after?.kind === "node") {
    const n = doc.nodes[nodeIndex(doc, after.id)];
    if (n) {
      anchor = n.id;
      if (n.kind === "step") {
        split = doc.arrows.findIndex((a) => a.from === n.id);
      } else if (n.kind === "decision") {
        const used = new Set(doc.arrows.filter((a) => a.from === n.id).map((a) => a.on ?? ""));
        const on = outcomesOf(doc, n).find((o) => !used.has(o));
        if (on !== undefined) free = { from: n.id, on };
      }
    }
  }

  const at = anchor === null ? -1 : nodeIndex(doc, anchor);
  const nodes = at < 0 ? [...doc.nodes, node] : insertAt(doc.nodes, at + 1, node);
  let arrows = doc.arrows;
  if (split >= 0) {
    const old = doc.arrows[split];
    arrows = replaceAt(arrows, split, { ...old, to: id });
    if (node.kind !== "end") {
      const out: DocArrow =
        node.kind === "decision"
          ? { from: id, to: old.to, on: outcomesOf(doc, node)[0] }
          : { from: id, to: old.to };
      arrows = insertFrom(arrows, old.from, out);
    }
  } else if (free) {
    arrows = insertFrom(arrows, free.from, withOn({ from: free.from, to: id }, free.on));
  }
  return { doc: { ...doc, nodes, arrows }, selection: { kind: "node", id }, refused: null };
}

function newNode(kind: "step" | "decision" | "end", id: string): DocNode {
  switch (kind) {
    case "step":
      return {
        kind,
        id,
        name: NEW_NAMES.step,
        performer: "chat",
        skills: [],
        privacy: "cheap",
        permission: "inherit",
        consumes: [],
        produces: [],
        nod: false,
      };
    case "decision":
      return { kind, id, name: NEW_NAMES.decision, check: "" };
    case "end":
      return { kind, id, result: "done" };
  }
}

/** `step_N`, `decision_N` or `end_N` with the smallest free N from 1. */
function nextId(doc: PlaybookDoc, kind: string): string {
  const taken = new Set(doc.nodes.map((n) => n.id));
  let n = 1;
  while (taken.has(`${kind}_${n}`)) n++;
  return `${kind}_${n}`;
}

function nodeIndex(doc: PlaybookDoc, id: string): number {
  return doc.nodes.findIndex((n) => n.id === id);
}

function arrowIndex(doc: PlaybookDoc, key: string): number {
  return doc.arrows.findIndex((a) => arrowKey(a) === key);
}

/** Right after the last arrow with the same source, else at the end. */
function insertFrom(arrows: DocArrow[], from: string, arrow: DocArrow): DocArrow[] {
  let last = -1;
  arrows.forEach((a, i) => {
    if (a.from === from) last = i;
  });
  return last < 0 ? [...arrows, arrow] : insertAt(arrows, last + 1, arrow);
}

function withOn(a: DocArrow, on: string): DocArrow {
  return on === "" ? { from: a.from, to: a.to } : { from: a.from, to: a.to, on };
}

function insertAt<T>(list: T[], i: number, item: T): T[] {
  return [...list.slice(0, i), item, ...list.slice(i)];
}

function replaceAt<T>(list: T[], i: number, item: T): T[] {
  return list.map((x, j) => (j === i ? item : x));
}

/** The same array when it does not name `from`, so untouched records stay the same objects. */
function swap(list: string[], from: string, to: string): string[] {
  return list.includes(from) ? list.map((x) => (x === from ? to : x)) : list;
}

/** The key replaced where it stands, so the map keeps the document's order. */
function renameKey<V>(record: Record<string, V>, from: string, to: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
}

function withoutKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function mapValues<V>(record: Record<string, V>, f: (v: V) => V): Record<string, V> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, f(v)]));
}

/** A field set to undefined leaves the record, so the file omits it. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** The selection when its node or arrow still exists, else none. */
function keep(doc: PlaybookDoc, sel: Selection): Selection {
  if (sel === null) return null;
  if (sel.kind === "node") return nodeIndex(doc, sel.id) >= 0 ? sel : null;
  return arrowIndex(doc, sel.key) >= 0 ? sel : null;
}

/** A selected arrow followed by position through a command that kept the arrow array aligned. */
function follow(before: PlaybookDoc, arrows: DocArrow[], sel: Selection): Selection {
  if (sel?.kind !== "arrow") return sel;
  const i = arrowIndex(before, sel.key);
  return i < 0 ? null : { kind: "arrow", key: arrowKey(arrows[i]) };
}

// Card 483: the playbook document as the editor holds it. The shape is the
// file's own (snake case, the canonical form's fields), so the store can send
// it to the draft check and the save route as it stands.

export interface ModelRef {
  provider: string;
  model: string;
}

export interface DocStep {
  kind: "step";
  id: string;
  name: string;
  goal?: string;
  performer: string;
  role?: string;
  skills: string[];
  model?: string;
  privacy: string;
  permission: string;
  consumes: string[];
  produces: string[];
  nod: boolean;
}

export interface DocDecision {
  kind: "decision";
  id: string;
  name: string;
  check: string;
  outcomes?: string[];
  max_rounds?: number;
}

export interface DocEnd {
  kind: "end";
  id: string;
  result: string;
}

export type DocNode = DocStep | DocDecision | DocEnd;

export interface DocArrow {
  from: string;
  to: string;
  on?: string;
}

export interface DocCheck {
  kind: string;
  documents?: string[];
  forbid?: string[];
  run?: string;
  model?: string;
  reads?: string[];
  ask?: string;
  labels?: string[];
}

export interface DocDocumentType {
  name: string;
  purpose: string;
  location: string;
  template?: string;
  sections: string[];
}

export interface PlaybookDoc {
  schema_version: number;
  id: string;
  name: string;
  description: string;
  models: Record<string, { primary: ModelRef; fallbacks: ModelRef[] }>;
  documents: Record<string, DocDocumentType>;
  checks: Record<string, DocCheck>;
  vars: Record<string, string>;
  start: string;
  nodes: DocNode[];
  arrows: DocArrow[];
  contents: { skills: string[]; agents: string[]; hooks: string[]; commands: string[]; workflows: string[] };
}

export type Selection = { kind: "node"; id: string } | { kind: "arrow"; key: string } | null;

/** One arrow per outcome (spec rule 3), so the source and the outcome name an arrow. */
export function arrowKey(a: DocArrow): string {
  return `${a.from}|${a.on ?? ""}`;
}

/** The outcomes a decision leaves by before max_rounds adds exhausted. */
export function baseOutcomesOf(doc: PlaybookDoc, d: DocDecision): string[] {
  if (d.outcomes && d.outcomes.length > 0) return [...d.outcomes];
  const c = doc.checks[d.check];
  if (c && (c.kind === "review" || c.kind === "human") && c.labels && c.labels.length > 0)
    return [...c.labels];
  return ["pass", "fail"];
}

/** The web twin of PlaybookValidator.outcomesOf, used to draw handles only.
 *  The store compares it with the server's answer on every view (Task 8). */
export function outcomesOf(doc: PlaybookDoc, node: DocNode): string[] {
  if (node.kind === "end") return [];
  if (node.kind === "step") return [""];
  // A Set in insertion order, as the Java LinkedHashSet: a repeated outcome counts once.
  const out = new Set(baseOutcomesOf(doc, node));
  if (node.max_rounds !== undefined && node.max_rounds !== null) out.add("exhausted");
  return [...out];
}

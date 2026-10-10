// The web store of Spectrolyzr (card 484, spec P5; one page since card 515).
//
// One module store read with useSyncExternalStore, the idiom of state/
// playbooks.ts: what the page makes (a new project or a new playbook), the
// catalog the server offers, the choices made on the page, the preview of the
// files those choices render, and the last answer of the generate route. It
// lives here and not in the page so a switch of segment does not lose the
// choices; the server owns every fact, this file mirrors its answers.
//
// On Playbook, Generate makes a playbook alone (card 515, decision E): a copy
// of the shipped spectro pack through the copy route, then the model choices
// of the page written through the file route of the editor, which stores the
// canonical form. Nothing is pinned and no project is written.
//
// The preview is fetched on every change of archetype, language, add-ons or
// name once those are set. Answers are applied in the order the choices were
// made: a slow answer for an earlier choice never overwrites a later one.

import { useSyncExternalStore } from "react";
import { noteFolder } from "./playbooks";

export type Bilingual = { en: string; de: string };

export interface LyzrCatalog {
  archetypes: { id: string; name: Bilingual; description: Bilingual }[];
  languages: { id: string; name: string }[];
  addons: { id: string; name: Bilingual; description: Bilingual }[];
}

export interface LyzrChoices {
  archetype: string | null;
  language: string | null;
  addons: string[];
  name: string;
  dir: string;
  playbookDir: string;
}

export interface LyzrFile {
  root: "project" | "playbook";
  path: string;
  why: Bilingual;
  size: number;
  content: string;
}

export interface LyzrPreview {
  files: LyzrFile[];
  commands: { test: string; check: string };
}

export type LyzrResult =
  | {
      kind: "written";
      /** Null for a new playbook alone. */
      project: { dir: string; written: string[] } | null;
      playbook: { dir: string; written: string[] } | null;
      pinned: boolean;
    }
  | { kind: "conflicts"; project: string[]; playbook: string[] }
  | { kind: "invalid"; field: string; message: string }
  | { kind: "failed"; message: string };

/** What the page makes: a project (with the playbook add-on, its playbook too) or a playbook alone (card 515). */
export type LyzrKind = "project" | "playbook";

/** The model choices a playbook names, in the order the page shows them. */
export const MODEL_ROLES = ["fast", "standard", "strong", "judge"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** A provider and one of the models the registry lists for it. */
export interface ModelPick {
  provider: string;
  model: string;
}

/** The id of the playbook the product ships, the one a new playbook copies. */
const BUNDLED = "spectro";

interface LyzrState {
  kind: LyzrKind;
  choices: LyzrChoices;
  /** The model per role for a new playbook; a role left out keeps the pack's model. */
  models: Partial<Record<ModelRole, ModelPick>>;
  catalog: LyzrCatalog | null;
  preview: LyzrPreview | null;
  result: LyzrResult | null;
}

/** The server's rule for a project name (lower case, digits, single hyphens, 40 at most). */
const NAME_RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NAME_MAX = 40;

const EMPTY_CHOICES: LyzrChoices = {
  archetype: null,
  language: null,
  addons: [],
  name: "",
  dir: "",
  playbookDir: "",
};

const INITIAL: LyzrState = {
  kind: "project",
  choices: EMPTY_CHOICES,
  models: {},
  catalog: null,
  preview: null,
  result: null,
};

let state: LyzrState = INITIAL;
let previewSeq = 0;
const listeners = new Set<() => void>();

function set(next: LyzrState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** What the page makes, its choices, the catalog, the preview and the last result. */
export function useLyzr(): LyzrState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The server's own words for a refusal, else the status. */
async function refusal(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => ({}));
  const message = (body as { message?: unknown }).message;
  return new Error(typeof message === "string" && message !== "" ? message : `HTTP ${res.status}`);
}

/** Read the archetypes, languages and add-ons the server offers. */
export async function loadCatalog(): Promise<void> {
  const res = await fetch("/api/spectrolyzr");
  if (!res.ok) throw await refusal(res);
  const catalog = (await res.json()) as LyzrCatalog;
  set({
    ...state,
    catalog,
    choices: { ...state.choices, addons: inCatalogOrder(state.choices.addons, catalog) },
  });
}

/** The add-on ids in the catalog's order, whatever order they were chosen in; unknown ids keep their place at the end. */
function inCatalogOrder(addons: string[], catalog: LyzrCatalog | null): string[] {
  if (catalog === null) return addons;
  const rank = (id: string): number => {
    const at = catalog.addons.findIndex((a) => a.id === id);
    return at < 0 ? catalog.addons.length : at;
  };
  return [...addons].sort((a, b) => rank(a) - rank(b));
}

/** Whether a project name passes the server's rule; the page enables Generate on it. */
export function nameUsable(name: string): boolean {
  return name.length <= NAME_MAX && NAME_RULE.test(name);
}

function previewUrl(c: LyzrChoices): string | null {
  if (c.archetype === null || c.language === null || !nameUsable(c.name)) return null;
  const addons = c.addons.map(encodeURIComponent).join(",");
  return (
    `/api/spectrolyzr/preview?archetype=${encodeURIComponent(c.archetype)}` +
    `&language=${encodeURIComponent(c.language)}&addons=${addons}&name=${encodeURIComponent(c.name)}`
  );
}

async function refreshPreview(): Promise<void> {
  const seq = ++previewSeq;
  const url = previewUrl(state.choices);
  if (url === null) {
    if (state.preview !== null) set({ ...state, preview: null });
    return;
  }
  let preview: LyzrPreview | null = null;
  try {
    const res = await fetch(url);
    if (res.ok) preview = (await res.json()) as LyzrPreview;
  } catch {
    preview = null;
  }
  if (seq !== previewSeq) return;
  set({ ...state, preview });
}

/**
 * Change one or more choices. The preview is fetched again when the archetype,
 * the language, the add-ons or the name changed; a change to a folder does not
 * touch it. A change of any choice clears the last result.
 *
 * @param patch the choices to set
 */
export function choose(patch: Partial<LyzrChoices>): void {
  const merged: LyzrChoices = { ...state.choices, ...patch };
  merged.addons = inCatalogOrder(merged.addons, state.catalog);
  const before = state.choices;
  const changed = (Object.keys(merged) as (keyof LyzrChoices)[]).some((k) =>
    k === "addons" ? merged.addons.join("\n") !== before.addons.join("\n") : merged[k] !== before[k],
  );
  if (!changed) return;
  const affectsPreview =
    merged.archetype !== before.archetype ||
    merged.language !== before.language ||
    merged.name !== before.name ||
    merged.addons.join("\n") !== before.addons.join("\n");
  set({ ...state, choices: merged, result: null });
  if (affectsPreview) void refreshPreview();
}

/**
 * Switch between a new project and a new playbook. The choices stay; the last
 * result goes, because Generate now means something else.
 *
 * @param kind what the page makes from now on
 */
export function chooseKind(kind: LyzrKind): void {
  if (state.kind !== kind) set({ ...state, kind, result: null });
}

/**
 * Choose the model of one role for a new playbook, or give the role back to
 * the pack's model with null. Clears the last result.
 *
 * @param role the model choice of the playbook
 * @param pick a provider and one of its listed models, or null
 */
export function chooseModel(role: ModelRole, pick: ModelPick | null): void {
  const now = state.models[role];
  if (pick === null ? now === undefined : now?.provider === pick.provider && now.model === pick.model) return;
  const models = { ...state.models };
  if (pick === null) delete models[role];
  else models[role] = { provider: pick.provider, model: pick.model };
  set({ ...state, models, result: null });
}

/**
 * The folder the page proposes for the playbook: a sibling of the project
 * folder, named after the project. Empty while either is not set.
 *
 * @param dir  the project folder
 * @param name the project name
 */
export function suggestPlaybookDir(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (trimmed === "" || name === "") return "";
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (at < 0) return `${name}-playbook`;
  const sep = trimmed[at];
  const parent = trimmed.slice(0, at);
  return `${parent}${sep}${name}-playbook`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function written(value: unknown): { dir: string; written: string[] } {
  const v = (value ?? {}) as { dir?: unknown; written?: unknown };
  return { dir: typeof v.dir === "string" ? v.dir : "", written: strings(v.written) };
}

/**
 * Generate the project, and with the playbook add-on the playbook folder, with
 * the current choices. A refusal is a result, not a throw: the page shows the
 * conflicting paths or marks the named field. The result also stays in the store.
 */
export async function generate(): Promise<LyzrResult> {
  const c = state.choices;
  let result: LyzrResult;
  if (c.archetype === null || c.language === null) {
    const field = c.archetype === null ? "archetype" : "language";
    result = { kind: "invalid", field, message: `Choose a ${field} first.` };
    set({ ...state, result });
    return result;
  }
  try {
    const res = await fetch("/api/spectrolyzr/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        archetype: c.archetype,
        language: c.language,
        addons: c.addons,
        name: c.name,
        dir: c.dir,
        playbookDir: c.playbookDir,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`;
    if (res.ok) {
      result = {
        kind: "written",
        project: written(body.project),
        playbook: body.playbook === null || body.playbook === undefined ? null : written(body.playbook),
        pinned: body.pinned === true,
      };
    } else if (res.status === 409) {
      const conflicts = (body.conflicts ?? {}) as { project?: unknown; playbook?: unknown };
      result = {
        kind: "conflicts",
        project: strings(conflicts.project),
        playbook: strings(conflicts.playbook),
      };
    } else if (res.status === 400) {
      result = { kind: "invalid", field: typeof body.field === "string" ? body.field : "", message };
    } else {
      result = { kind: "failed", message };
    }
  } catch (e) {
    result = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  set({ ...state, result });
  return result;
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** The server's message of a refusal body, else the status. */
function messageOf(body: Record<string, unknown>, status: number): string {
  return typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${status}`;
}

/** The findings of a refused save as one line, `path: message` each. */
function findingsOf(body: Record<string, unknown>): string {
  const findings = Array.isArray(body.findings) ? body.findings : [];
  return findings
    .map((f) => {
      const v = (f ?? {}) as { path?: unknown; message?: unknown };
      return `${typeof v.path === "string" ? v.path : ""}: ${typeof v.message === "string" ? v.message : ""}`;
    })
    .join("; ");
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Generate a new playbook alone (card 515, decision E): copy the shipped
 * spectro pack into the playbook folder, read the copy's canonical tree and
 * hash through the draft route, and write it back through the file route with
 * the chosen models. The copy route registers the folder, so it joins the
 * known list; nothing is pinned. A refusal of the copy is shown as the
 * project side shows it: 409 lists the paths, 400 marks the folder. A refusal
 * after the copy says that the copy is there with the pack's models.
 */
export async function generatePlaybook(): Promise<LyzrResult> {
  const dir = state.choices.playbookDir.trim();
  const picks = state.models;
  let result: LyzrResult;
  if (dir === "") {
    result = { kind: "invalid", field: "playbookDir", message: "Choose a playbook folder first." };
    set({ ...state, result });
    return result;
  }
  try {
    result = await copyAndChoose(dir, picks);
  } catch (e) {
    result = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  set({ ...state, result });
  return result;
}

async function copyAndChoose(dir: string, picks: Partial<Record<ModelRole, ModelPick>>): Promise<LyzrResult> {
  const copied = await fetch(`/api/playbooks/bundled/${BUNDLED}/copy`, jsonInit("POST", { dir }));
  const copy = await bodyOf(copied);
  if (copied.status === 409) return { kind: "conflicts", project: [], playbook: strings(copy.conflicts) };
  if (copied.status === 400) return { kind: "invalid", field: "playbookDir", message: messageOf(copy, 400) };
  if (!copied.ok) return { kind: "failed", message: messageOf(copy, copied.status) };
  const playbook = written(copy);
  const root = playbook.dir !== "" ? playbook.dir : dir;
  playbook.dir = root;
  noteFolder(root);

  const kept = `Copied the spectro playbook into ${root} with the pack's models`;
  const read = await fetch(`/api/playbooks/draft?dir=${encodeURIComponent(root)}`);
  const view = await bodyOf(read);
  const doc = view.document as {
    models?: Record<string, { primary: ModelPick; fallbacks: ModelPick[] }>;
  } | null;
  if (!read.ok || doc === null || typeof doc !== "object" || typeof view.diskHash !== "string") {
    return {
      kind: "failed",
      message: `${kept}; the copy could not be read back: ${messageOf(view, read.status)}`,
    };
  }
  const models = { ...(doc.models ?? {}) };
  for (const role of MODEL_ROLES) {
    const pick = picks[role];
    if (pick === undefined) continue;
    models[role] = {
      primary: { provider: pick.provider, model: pick.model },
      fallbacks: models[role]?.fallbacks ?? [],
    };
  }
  const saved = await fetch(
    `/api/playbooks/file?dir=${encodeURIComponent(root)}`,
    jsonInit("PUT", { baseHash: view.diskHash, playbook: { ...doc, models } }),
  );
  if (!saved.ok) {
    const body = await bodyOf(saved);
    const why = findingsOf(body) || messageOf(body, saved.status);
    return { kind: "failed", message: `${kept}; the model choices were refused: ${why}` };
  }
  return { kind: "written", project: null, playbook, pinned: false };
}

/** Test seam: forget the catalog, the choices, the models, the preview and the result. */
export function __resetLyzr(): void {
  previewSeq++;
  state = INITIAL;
  for (const l of listeners) l();
}

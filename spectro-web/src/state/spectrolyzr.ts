// The web store of the Spectrolyzr wizard (card 484, spec P5).
//
// One module store read with useSyncExternalStore, the idiom of state/
// playbooks.ts: the catalog the server offers, the choices made on the three
// steps, the preview of the files those choices render, and the last answer of
// the generate route. It lives here and not in the wizard so a switch of
// segment does not lose the choices; the server owns every fact, this file
// mirrors its answers.
//
// The preview is fetched on every change of archetype, language, add-ons or
// name once those are set. Answers are applied in the order the choices were
// made: a slow answer for an earlier choice never overwrites a later one.

import { useSyncExternalStore } from "react";

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
      project: { dir: string; written: string[] };
      playbook: { dir: string; written: string[] } | null;
      pinned: boolean;
    }
  | { kind: "conflicts"; project: string[]; playbook: string[] }
  | { kind: "invalid"; field: string; message: string }
  | { kind: "failed"; message: string };

type Step = 1 | 2 | 3;

interface LyzrState {
  step: Step;
  choices: LyzrChoices;
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

const INITIAL: LyzrState = { step: 1, choices: EMPTY_CHOICES, catalog: null, preview: null, result: null };

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

/** The wizard's step, choices, catalog, preview and last result. */
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

/** Whether a project name passes the server's rule; the wizard enables Next on it. */
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

/** Go to a step of the wizard. */
export function goTo(step: Step): void {
  if (state.step !== step) set({ ...state, step });
}

/**
 * The folder the wizard proposes for the playbook: a sibling of the project
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
 * the current choices. A refusal is a result, not a throw: the wizard shows the
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

/** Test seam: forget the catalog, the choices, the preview and the result. */
export function __resetLyzr(): void {
  previewSeq++;
  state = INITIAL;
  for (const l of listeners) l();
}

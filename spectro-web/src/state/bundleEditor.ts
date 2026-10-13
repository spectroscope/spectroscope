// Card 525: the store behind the bundle tabs of the playbook pane.
//
// One module store read with useSyncExternalStore, the idiom of the other
// state files. It holds the tree of the folder the pane shows (GET
// /api/playbooks/tree, card 522), the one text file open on the right (read,
// write with the hash it was read with, delete), the import sources of card
// 523 and the panel or confirmation the toolbar opened. The server is the
// authority on every refusal: a refusal keeps its reason code, which
// reasonText turns into an English or German sentence, and its own words.
//
// playbook.json is never opened as text: it opens the graph editor of card
// 483, which checks it before it saves.

import { useSyncExternalStore } from "react";
import { dict, t, type Lang } from "../i18n/i18n";
import type { FileNode } from "../workspace/FileBrowser";
import { loadContents } from "./playbookContents";
import { editorState, loadView, openEditor } from "./playbookEditor";
import { loadPlaybook, showTab, type PaneTab } from "./playbooks";

/** The kinds of contents a playbook lists, as the server names them. */
export type KindId = "skills" | "agents" | "hooks" | "commands" | "workflows";

export interface PaneTabSpec {
  id: PaneTab;
  /** The i18n key of the tab's label. */
  label: string;
  /** The kind the tab edits, for the five kind tabs. */
  kind?: KindId;
  /** The folder the file browser is scoped to; null for the whole folder. Absent on Playbook and New. */
  folder?: string | null;
}

/** The tabs of the playbook pane, in the order the header draws them. The tests read this list. */
export const PANE_TABS: readonly PaneTabSpec[] = [
  // Card 563 (owner decision): the first tab is Steps; its id stays.
  { id: "playbook", label: "pbb.tab.steps" },
  { id: "skills", label: "pbb.tab.skills", kind: "skills", folder: "skills" },
  { id: "agents", label: "pbb.tab.agents", kind: "agents", folder: "agents" },
  { id: "hooks", label: "pbb.tab.hooks", kind: "hooks", folder: "hooks" },
  { id: "commands", label: "pbb.tab.commands", kind: "commands", folder: "commands" },
  { id: "workflows", label: "pbb.tab.workflows", kind: "workflows", folder: "workflows" },
  { id: "plugin", label: "pbp.tab" },
  { id: "files", label: "pbb.tab.files", folder: null },
  { id: "lyzr", label: "lyzr.tab" },
];

export interface TreeView {
  root: string;
  truncated: boolean;
  /** True when the walk stopped at the loader's file count; what it did not reach is unknown. */
  capped: boolean;
  /** The folders at the loader's depth that hold more than the tree lists. */
  deeper: string[];
  entries: FileNode[];
  findings: { path: string; message: string }[];
}

export interface OpenFile {
  dir: string;
  path: string;
  /** The text in the textarea. */
  text: string;
  /** The text as it was read or last saved; the file is dirty while text differs. */
  base: string;
  /** The sha256 the text was read with, sent as baseHash. */
  sha256: string;
  size: number;
  status: "loading" | "ready" | "saving" | "changed" | "refused" | "unreadable";
  /** The hash on disk after a 409. */
  diskHash: string | null;
  reason: string | null;
  message: string | null;
}

export interface InstalledSkill {
  root: string;
  pack: string | null;
  name: string;
  description: string;
  inPlaybook: boolean;
  importable: boolean;
  why?: string;
}

export interface CatalogueSkill {
  id: string;
  pack: string;
  name: string;
  description: string;
  licence: string;
  inPlaybook: boolean;
}

export interface ImportSources {
  installed: InstalledSkill[];
  catalogue: CatalogueSkill[];
  hooks: {
    event: string;
    matcher: string | null;
    command: string;
    timeoutSeconds: number | null;
    scripts: string[];
    /** Why the import leaves this hook out (card 538), or null when it is written. */
    left?: string | null;
  }[];
  hooksInPlaybook: boolean;
}

export type SkillItem =
  | { source: "installed"; root: string; pack: string | null; name: string }
  | { source: "catalogue"; pack: string; name: string };

export type Panel = "import-skills" | "import-hooks" | "new-agent" | "new-command";

export type Answer = { ok: true } | { ok: false; reason: string; message: string };

export interface EntryRow {
  path: string;
  state: "listed" | "disk-only" | "missing";
  /** The loader's finding on this entry, when it has one. */
  finding: string | null;
}

export interface BundleEditorState {
  dir: string | null;
  tree: TreeView | null;
  treeError: string | null;
  file: OpenFile | null;
  sources: ImportSources | null;
  panel: Panel | null;
  /** The entry Remove asks about; listed is false for an entry on disk only. */
  confirm: { kind: KindId; path: string; listed: boolean } | null;
  busy: boolean;
  /** The outcome of the last toolbar action, shown under the toolbar. */
  notice: { ok: boolean; reason: string; message: string } | null;
}

/** The root files every playbook keeps; the server refuses to remove them. */
export const PROTECTED = ["playbook.json", "LICENSE", "PROVENANCE.md"];

const INITIAL: BundleEditorState = {
  dir: null,
  tree: null,
  treeError: null,
  file: null,
  sources: null,
  panel: null,
  confirm: null,
  busy: false,
  notice: null,
};

let state: BundleEditorState = INITIAL;
const listeners = new Set<() => void>();
/** Bumped by every open, so an answer for a file that is no longer asked for is dropped. */
let openSeq = 0;

function set(patch: Partial<BundleEditorState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** React hook: the bundle editor state. */
export function useBundleEditor(): BundleEditorState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The state right now, for code outside a component. */
export function bundleEditorState(): BundleEditorState {
  return state;
}

/** Whether the open file has changes that are not on disk. */
export function fileDirty(s: BundleEditorState = state): boolean {
  return s.file !== null && s.file.text !== s.file.base;
}

/**
 * The sentence for a refusal in the language shown: the house sentence for a
 * reason code the pane knows, else the server's own words.
 *
 * @param lang    the language
 * @param reason  the server's reason code
 * @param message the server's sentence
 */
export function reasonText(lang: Lang, reason: string, message: string): string {
  const key = `pbb.reason.${reason}`;
  return dict[key] !== undefined ? t(lang, key) : message;
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => ({}));
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function refusedOf(status: number, body: Record<string, unknown>): { reason: string; message: string } {
  const reason =
    typeof body.reason === "string" && body.reason !== "" ? body.reason : status === 404 ? "hidden" : "";
  const message = typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${status}`;
  return { reason, message };
}

function query(dir: string, workspace: string | null): string {
  const ws = workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`;
  return `dir=${encodeURIComponent(dir)}${ws}`;
}

// ---- the tree ------------------------------------------------------------------------------

/**
 * Read the tree of a registered folder in one request. A refusal clears the
 * tree and keeps the server's words.
 *
 * @param dir the registered playbook folder
 */
export async function loadTree(dir: string): Promise<void> {
  if (state.dir !== dir) {
    if (state.file !== null && state.file.dir !== dir) openSeq++;
    set({
      dir,
      tree: null,
      treeError: null,
      file: state.file !== null && state.file.dir === dir ? state.file : null,
      sources: null,
      panel: null,
      confirm: null,
      notice: null,
    });
  }
  let res: Response;
  try {
    res = await fetch(`/api/playbooks/tree?dir=${encodeURIComponent(dir)}`);
  } catch (e) {
    set({ treeError: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (state.dir !== dir) return;
  if (!res.ok) {
    set({ tree: null, treeError: refusedOf(res.status, await bodyOf(res)).message });
    return;
  }
  set({ tree: (await res.json()) as TreeView, treeError: null });
}

/**
 * Whether the part of the tree a tab shows holds more than it lists: a
 * folder at the loader's depth inside it goes deeper. When the walk stopped
 * at the file count, every part may be cut, so every tab says so.
 *
 * @param tree   the tree of the folder
 * @param folder the top folder of the tab, or null for the whole folder
 */
export function scopeTruncated(tree: TreeView, folder: string | null): boolean {
  if (tree.capped) return true;
  if (folder === null) return tree.deeper.length > 0;
  return tree.deeper.some((p) => p.startsWith(`${folder}/`));
}

/**
 * The part of the tree a tab shows: the children of a top folder, or the
 * whole tree for Files.
 *
 * @param entries the top level nodes of the tree
 * @param folder  the top folder, or null for the whole folder
 * @return the nodes, or null when the folder does not exist
 */
export function scopeTree(entries: FileNode[], folder: string | null): FileNode[] | null {
  if (folder === null) return entries;
  const top = entries.find((n) => n.dir && n.path === folder);
  return top === undefined ? null : top.children;
}

/** One path segment of a contents entry, the loader's rule (PlaybookValidator.SEG). */
const SEG = "[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*";
const ON_DISK: Record<KindId, { dir: boolean; name: RegExp }> = {
  skills: { dir: true, name: new RegExp(`^${SEG}$`, "u") },
  agents: { dir: false, name: new RegExp(`^${SEG}\\.md$`, "u") },
  hooks: { dir: false, name: /^hooks\.json$/ },
  commands: { dir: false, name: new RegExp(`^${SEG}\\.md$`, "u") },
  workflows: { dir: false, name: /^[^/\\]+$/ },
};

/**
 * The contents entries of a kind beside the folder on disk: each listed
 * entry as listed or listed but missing (the loader's rule 8), then each
 * entry the folder holds that `contents` does not list.
 *
 * @param kind     the kind
 * @param listed   the entries `contents` lists for the kind
 * @param entries  the top level nodes of the tree
 * @param findings the loader's findings on the folder
 */
export function entriesOf(
  kind: KindId,
  listed: string[],
  entries: FileNode[],
  findings: { path: string; message: string }[],
): EntryRow[] {
  const rule = ON_DISK[kind];
  const onDisk = (scopeTree(entries, kind) ?? [])
    .filter((n) => n.dir === rule.dir && rule.name.test(n.name))
    .map((n) => n.path);
  const present = new Set(onDisk);
  const rows: EntryRow[] = listed.map((path, i) => ({
    path,
    state: present.has(path) ? "listed" : "missing",
    finding: findings.find((f) => f.path === `contents.${kind}[${i}]`)?.message ?? null,
  }));
  for (const path of onDisk) {
    if (!listed.includes(path)) rows.push({ path, state: "disk-only", finding: null });
  }
  return rows;
}

// ---- one file ------------------------------------------------------------------------------

async function readInto(dir: string, path: string, seq: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/playbooks/read?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`);
  } catch (e) {
    if (seq !== openSeq) return;
    set({
      file: { ...unreadable(dir, path), reason: "", message: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
  if (seq !== openSeq) return;
  if (!res.ok) {
    const why = refusedOf(res.status, await bodyOf(res));
    set({ file: { ...unreadable(dir, path), ...why } });
    return;
  }
  const body = (await res.json()) as { text: string; sha256: string; size: number };
  if (seq !== openSeq) return;
  set({
    file: {
      dir,
      path,
      text: body.text,
      base: body.text,
      sha256: body.sha256,
      size: body.size,
      status: "ready",
      diskHash: null,
      reason: null,
      message: null,
    },
  });
}

function unreadable(dir: string, path: string): OpenFile {
  return {
    dir,
    path,
    text: "",
    base: "",
    sha256: "",
    size: 0,
    status: "unreadable",
    diskHash: null,
    reason: null,
    message: null,
  };
}

/**
 * Whether a path of the folder opens in the graph editor on the Playbook tab
 * rather than as text: playbook.json at the root.
 *
 * @param path the path in the folder
 */
export function opensGraph(path: string): boolean {
  return path === "playbook.json";
}

/**
 * Open a file of the folder on the right. playbook.json turns to the
 * Playbook tab and opens the graph editor instead. Unsaved changes in the
 * open file block the open.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace the graph editor resolves skills against
 * @param path      the path in the folder
 * @return what happened
 */
export async function openPath(
  dir: string,
  workspace: string | null,
  path: string,
): Promise<"opened" | "graph" | "blocked"> {
  if (fileDirty()) return "blocked";
  openSeq++;
  if (opensGraph(path)) {
    set({ file: null });
    showTab("playbook");
    try {
      await openEditor(dir, workspace);
    } catch (e) {
      set({ notice: { ok: false, reason: "", message: e instanceof Error ? e.message : String(e) } });
    }
    return "graph";
  }
  const seq = openSeq;
  set({ file: { ...unreadable(dir, path), status: "loading" } });
  await readInto(dir, path, seq);
  return "opened";
}

/**
 * Change the text of the open file.
 *
 * @param text the new text
 */
export function editText(text: string): void {
  const f = state.file;
  if (f === null || f.status === "loading" || f.status === "unreadable") return;
  set({ file: { ...f, text, status: f.status === "refused" ? "ready" : f.status } });
}

/** Put the text back to what is on disk as it was read. */
export function discardEdits(): void {
  const f = state.file;
  if (f === null) return;
  set({ file: { ...f, text: f.base, status: f.status === "changed" ? "changed" : "ready" } });
}

/** Read the open file again from disk, dropping the edit. Offered after a 409. */
export async function reloadFile(): Promise<void> {
  const f = state.file;
  if (f === null) return;
  const seq = ++openSeq;
  await readInto(f.dir, f.path, seq);
}

/**
 * Write the open file with the hash it was read with. A 409 says the file on
 * disk changed since; any other refusal keeps its reason.
 */
export async function saveFile(): Promise<void> {
  const f = state.file;
  if (f === null || f.status === "saving" || f.status === "loading" || f.status === "unreadable") return;
  const sent = f.text;
  set({ file: { ...f, status: "saving" } });
  let res: Response;
  try {
    res = await fetch(
      "/api/playbooks/write",
      jsonInit("PUT", { dir: f.dir, path: f.path, text: sent, baseHash: f.sha256 }),
    );
  } catch (e) {
    set({
      file: {
        ...current(f),
        status: "refused",
        reason: "",
        message: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }
  const body = await bodyOf(res);
  const now = current(f);
  if (res.ok) {
    set({
      file: {
        ...now,
        base: sent,
        sha256: typeof body.sha256 === "string" ? body.sha256 : now.sha256,
        size: typeof body.size === "number" ? body.size : now.size,
        status: "ready",
        diskHash: null,
        reason: null,
        message: null,
      },
    });
    void loadTree(f.dir);
    return;
  }
  const why = refusedOf(res.status, body);
  if (res.status === 409) {
    set({
      file: {
        ...now,
        status: "changed",
        diskHash: typeof body.diskHash === "string" ? body.diskHash : "",
        ...why,
      },
    });
    return;
  }
  set({ file: { ...now, status: "refused", ...why } });
}

/** The open file as the store holds it now, or the one given when it was closed meanwhile. */
function current(f: OpenFile): OpenFile {
  return state.file !== null && state.file.path === f.path && state.file.dir === f.dir ? state.file : f;
}

/** Remove the open file. The server refuses the protected root files and anything it does not open. */
export async function deleteFile(): Promise<void> {
  const f = state.file;
  if (f === null) return;
  let res: Response;
  try {
    res = await fetch(
      `/api/playbooks/file-at?dir=${encodeURIComponent(f.dir)}&path=${encodeURIComponent(f.path)}`,
      { method: "DELETE" },
    );
  } catch (e) {
    set({
      file: { ...f, status: "refused", reason: "", message: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
  if (res.ok) {
    openSeq++;
    set({ file: null });
    await loadTree(f.dir);
    return;
  }
  set({ file: { ...current(f), status: "refused", ...refusedOf(res.status, await bodyOf(res)) } });
}

// ---- the toolbar ---------------------------------------------------------------------------

/**
 * Open a panel under the toolbar: the skill picker, the hooks import or a New form.
 *
 * @param panel the panel
 */
export function openPanel(panel: Panel): void {
  set({ panel, confirm: null, notice: null });
}

/** Close the open panel. */
export function closePanel(): void {
  set({ panel: null });
}

/**
 * Ask before an entry is removed.
 *
 * @param kind the kind
 * @param path the entry
 * @param listed false for an entry on disk only
 */
export function askRemove(kind: KindId, path: string, listed = true): void {
  set({ confirm: { kind, path, listed }, panel: null, notice: null });
}

/** Keep the entry. */
export function cancelRemove(): void {
  set({ confirm: null });
}

/**
 * Read the skills and hooks the folder can import.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane, whose paths the hooks show as the project placeholder
 */
export async function loadSources(dir: string, workspace: string | null = null): Promise<void> {
  const ws = workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(`/api/playbooks/import-sources?dir=${encodeURIComponent(dir)}${ws}`);
  if (!res.ok) {
    const why = refusedOf(res.status, await bodyOf(res));
    set({ sources: null, notice: { ok: false, ...why } });
    return;
  }
  set({ sources: (await res.json()) as ImportSources });
}

/** After a change to the folder: the tree, the loaded playbook, the graph and the contents row. */
async function refresh(dir: string, workspace: string | null): Promise<void> {
  await Promise.all([
    loadTree(dir),
    loadPlaybook(dir, workspace ?? "").catch(() => undefined),
    loadView(dir, workspace).catch(() => undefined),
    loadContents(dir, workspace).catch(() => undefined),
  ]);
}

/**
 * Read the folder again after another store changed it (the Plugin tab of
 * card 526): the tree, the loaded playbook, the graph and the contents row.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 */
export function refreshBundle(dir: string, workspace: string | null): Promise<void> {
  return refresh(dir, workspace);
}

async function change(
  dir: string,
  workspace: string | null,
  url: string,
  body: Record<string, unknown>,
  done: string,
): Promise<Answer> {
  set({ busy: true, notice: null });
  let res: Response;
  try {
    res = await fetch(url, jsonInit("POST", { dir, ...body }));
  } catch (e) {
    const out = { ok: false as const, reason: "", message: e instanceof Error ? e.message : String(e) };
    set({ busy: false, notice: out });
    return out;
  }
  const answer = await bodyOf(res);
  if (!res.ok) {
    const out = { ok: false as const, ...refusedOf(res.status, answer) };
    set({ busy: false, notice: out });
    return out;
  }
  set({ busy: false, panel: null, confirm: null, notice: { ok: true, reason: done, message: "" } });
  await refresh(dir, workspace);
  return { ok: true };
}

/**
 * Copy skills into the folder (card 523): installed ones by root label, pack
 * and name, catalogue ones by pack and name.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param items     the ticked skills
 */
export function importSkills(dir: string, workspace: string | null, items: SkillItem[]): Promise<Answer> {
  return change(dir, workspace, "/api/playbooks/import-skills", { items }, "imported");
}

/**
 * Copy the hooks of the user settings into hooks/hooks.json.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param replace   true when the owner confirmed replacing an existing hooks.json
 */
export function importHooks(dir: string, workspace: string | null, replace: boolean): Promise<Answer> {
  return change(
    dir,
    workspace,
    "/api/playbooks/import-hooks",
    workspace === null ? { replace } : { replace, workspace },
    "imported",
  );
}

/**
 * Write agents/<name>.md from the template.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param name      the agent's name
 * @param type      explore, worker or research
 */
export function newAgent(dir: string, workspace: string | null, name: string, type: string): Promise<Answer> {
  return change(dir, workspace, "/api/playbooks/new-agent", { name, type }, "created");
}

/**
 * Write commands/<name>.md from the template.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param name      the command's name
 */
export function newCommand(dir: string, workspace: string | null, name: string): Promise<Answer> {
  return change(dir, workspace, "/api/playbooks/new-command", { name }, "created");
}

/**
 * Take an entry out of contents and remove its files.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param kind      the kind
 * @param path      the entry
 */
export async function removeEntry(
  dir: string,
  workspace: string | null,
  kind: KindId,
  path: string,
): Promise<Answer> {
  const out = await change(dir, workspace, "/api/playbooks/remove-content", { kind, path }, "removed");
  const f = state.file;
  if (out.ok && f !== null && (f.path === path || f.path.startsWith(`${path}/`))) {
    openSeq++;
    set({ file: null });
  }
  return out;
}

/**
 * Remove an entry that is on disk only. remove-content (card 523) removes
 * listed entries only, so the entry is listed first and then removed; when
 * listing is refused, nothing is removed and the refusal is shown.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param kind      the kind
 * @param path      the entry
 */
export async function removeUnlisted(
  dir: string,
  workspace: string | null,
  kind: KindId,
  path: string,
): Promise<Answer> {
  const listed = await listEntry(dir, workspace, kind, path);
  if (!listed.ok) return listed;
  return removeEntry(dir, workspace, kind, path);
}

/**
 * List an entry that is on disk only: read the draft, add the path to the
 * kind's contents and save it through the graph editor's save route with the
 * hash the draft was read with. Refused while the graph editor holds unsaved
 * changes, since the save would write past them.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param kind      the kind
 * @param path      the entry
 */
export async function listEntry(
  dir: string,
  workspace: string | null,
  kind: KindId,
  path: string,
): Promise<Answer> {
  const fail = (reason: string, message: string): Answer => {
    const out = { ok: false as const, reason, message };
    set({ busy: false, notice: out });
    return out;
  };
  const ed = editorState();
  if (ed.open && ed.dirty) return fail("draft-dirty", "The graph editor has unsaved changes.");
  set({ busy: true, notice: null });
  try {
    const read = await fetch(`/api/playbooks/draft?${query(dir, workspace)}`);
    const view = await bodyOf(read);
    const doc = view.document as { contents?: Partial<Record<KindId, string[]>> } | null | undefined;
    if (!read.ok) return fail(refusedOf(read.status, view).reason, refusedOf(read.status, view).message);
    if (view.editable !== true || doc === null || doc === undefined || typeof view.diskHash !== "string") {
      return fail("not-editable", "The playbook cannot be edited without losing part of it.");
    }
    const contents = {
      skills: [],
      agents: [],
      hooks: [],
      commands: [],
      workflows: [],
      ...(doc.contents ?? {}),
    };
    const list = contents[kind] ?? [];
    const next = { ...doc, contents: { ...contents, [kind]: list.includes(path) ? list : [...list, path] } };
    const saved = await fetch(
      `/api/playbooks/file?${query(dir, workspace)}`,
      jsonInit("PUT", { baseHash: view.diskHash, playbook: next }),
    );
    const answer = await bodyOf(saved);
    if (!saved.ok) {
      const findings = Array.isArray(answer.findings)
        ? (answer.findings as { path?: unknown; message?: unknown }[])
            .map((f) => `${String(f.path)}: ${String(f.message)}`)
            .join("; ")
        : "";
      const why = refusedOf(saved.status, answer);
      return fail(saved.status === 409 ? "changed" : why.reason, findings !== "" ? findings : why.message);
    }
  } catch (e) {
    return fail("", e instanceof Error ? e.message : String(e));
  }
  set({ busy: false, notice: { ok: true, reason: "listed", message: "" } });
  await refresh(dir, workspace);
  return { ok: true };
}

/** Test seam: forget the tree, the file, the sources and the panels. */
export function __resetBundleEditor(): void {
  openSeq++;
  state = INITIAL;
  for (const l of listeners) l();
}

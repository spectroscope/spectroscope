// Card 524: a playbook travels as a ZIP.
//
// The export asks GET /api/playbooks/export for a registered folder and saves
// what comes back under the name the server gives (<id>.playbook.zip). The
// import reads a chosen .zip with the session import's reader, checks it with
// the rules the server applies again (one top folder holding playbook.json,
// at most 200 files and 24 MB, every path relative and inside the loader's
// name rule, binary files only under docs/ and up to 2 MB), shows what it
// holds, and posts the entries to POST /api/playbooks/import for an empty
// folder the owner picks. A refusal of the server is kept word for word.
//
// The state lives in a module store read with useSyncExternalStore, the idiom
// of the other state files, so a static render can show it.

import { useSyncExternalStore } from "react";
import { readZip } from "../import/bundleZip";
import { noteFolder } from "./playbooks";

/** The most bytes a bundle carries, the server's ceiling. */
export const BUNDLE_MAX_BYTES = 24 * 1024 * 1024;
/** The most files a bundle carries, the loader's ceiling. */
export const BUNDLE_MAX_FILES = 200;
/** The largest binary file, allowed only under docs/. */
export const BUNDLE_MAX_BINARY = 2 * 1024 * 1024;
/** How much of a file is searched for a NUL byte, as on the server. */
const SNIFF_BYTES = 8192;

/** One entry as the server takes it: text for UTF-8 text, base64 for the rest. */
export type BundleEntry = { path: string; text: string } | { path: string; base64: string };

export interface BundleContents {
  skills: string[];
  agents: string[];
  hooks: string[];
  commands: string[];
  workflows: string[];
}

/** What a chosen file holds, once it passed the checks. */
export interface BundlePreview {
  entries: BundleEntry[];
  name: string;
  id: string;
  contents: BundleContents;
  bytes: number;
}

/** A refusal of the browser: an i18n key and its values. */
export interface BundleRefusal {
  key: string;
  vars?: Record<string, string | number>;
}

/** A refusal of the server: its reason, its sentence and, for findings, the list. */
export interface ServerRefusal {
  reason?: string;
  message: string;
  findings: { path: string; message: string }[];
}

export interface BundleState {
  preview: BundlePreview | null;
  refusal: BundleRefusal | null;
  server: ServerRefusal | null;
  busy: boolean;
  imported: string | null;
  exportRefusal: ServerRefusal | null;
}

const IDLE: BundleState = {
  preview: null,
  refusal: null,
  server: null,
  busy: false,
  imported: null,
  exportRefusal: null,
};

let state: BundleState = IDLE;
const listeners = new Set<() => void>();

function set(next: Partial<BundleState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The bundle import and export as the pane shows it. */
export function useBundleState(): BundleState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The state now, for tests and handlers. */
export function getBundleState(): BundleState {
  return state;
}

const SEG = "[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*";
const SEGMENT = new RegExp(`^${SEG}$`, "u");
const FILE_NAME = new RegExp(`^${SEG}(?:\\.[\\p{L}\\p{N}_-]+)*$`, "u");

/**
 * Whether a path below the top folder is one the server writes: relative, "/"
 * separated, no empty, "." or ".." part, every folder a segment of the
 * loader's rule and the file name that rule plus extensions after a dot.
 */
export function bundlePathOk(rel: string): boolean {
  if (rel === "" || rel.length > 512 || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0"))
    return false;
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (!SEGMENT.test(parts[i])) return false;
  return FILE_NAME.test(parts[parts.length - 1]);
}

/** What Finder adds when it zips a folder; never part of a playbook. */
function finderJunk(name: string): boolean {
  return name.startsWith("__MACOSX/") || name === ".DS_Store" || name.endsWith("/.DS_Store");
}

/** The UTF-8 text of the bytes, or null where the server would call them binary. */
function textOf(bytes: Uint8Array): string | null {
  const sniff = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < sniff; i++) if (bytes[i] === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function refuse(key: string, vars?: Record<string, string | number>): BundleRefusal {
  return vars === undefined ? { key } : { key, vars };
}

/**
 * Read and check a chosen bundle file.
 *
 * @param file the chosen .zip
 * @return what it holds, with the top folder taken off every path
 * @throws a BundleRefusal naming the first rule the file breaks
 */
export async function readPlaybookBundle(file: Blob): Promise<BundlePreview> {
  if (file.size > BUNDLE_MAX_BYTES) throw refuse("pb.bundle.err.tooLarge");
  let raw: { name: string; bytes: Uint8Array }[];
  try {
    raw = await readZip(new Uint8Array(await file.arrayBuffer()), { maxBytes: BUNDLE_MAX_BYTES });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (/more than \d+ bytes/.test(detail)) throw refuse("pb.bundle.err.tooLarge");
    throw refuse("pb.bundle.err.notZip", { detail });
  }
  const kept = raw.filter((e) => !finderJunk(e.name));
  if (kept.length > BUNDLE_MAX_FILES) throw refuse("pb.bundle.err.tooMany");
  for (const e of kept) {
    if (e.name.startsWith("/") || e.name.includes("\\") || /^[A-Za-z]:/.test(e.name)) {
      throw refuse("pb.bundle.err.path", { path: e.name });
    }
    const parts = e.name.split("/");
    if (parts.some((p) => p === "" || p === "." || p === ".."))
      throw refuse("pb.bundle.err.path", { path: e.name });
  }
  const tops = new Set(kept.map((e) => (e.name.includes("/") ? (e.name.split("/")[0] ?? "") : "")));
  const top = tops.size === 1 ? [...tops][0] : "";
  if (top === "" || !kept.some((e) => e.name === `${top}/playbook.json`)) throw refuse("pb.bundle.err.noTop");

  const entries: BundleEntry[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const e of kept) {
    const rel = e.name.slice(top.length + 1);
    if (!bundlePathOk(rel)) throw refuse("pb.bundle.err.path", { path: e.name });
    const folded = rel.toLowerCase();
    if (seen.has(folded)) throw refuse("pb.bundle.err.duplicate", { path: rel });
    seen.add(folded);
    bytes += e.bytes.length;
    if (bytes > BUNDLE_MAX_BYTES) throw refuse("pb.bundle.err.tooLarge");
    const text = textOf(e.bytes);
    if (text !== null) {
      entries.push({ path: rel, text });
    } else if (rel.startsWith("docs/") && e.bytes.length <= BUNDLE_MAX_BINARY) {
      entries.push({ path: rel, base64: base64Of(e.bytes) });
    } else {
      throw refuse("pb.bundle.err.binary", { path: rel });
    }
  }
  for (const rel of seen) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/")))
        throw refuse("pb.bundle.err.duplicate", { path: parts.slice(0, i).join("/") });
    }
  }

  const json = entries.find((e) => e.path === "playbook.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json !== undefined && "text" in json ? json.text : "");
  } catch {
    throw refuse("pb.bundle.err.json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw refuse("pb.bundle.err.json");
  const p = parsed as { id?: unknown; name?: unknown; contents?: unknown };
  const c = (p.contents ?? {}) as Record<string, unknown>;
  return {
    entries,
    name: typeof p.name === "string" ? p.name : "",
    id: typeof p.id === "string" ? p.id : "",
    contents: {
      skills: strings(c.skills),
      agents: strings(c.agents),
      hooks: strings(c.hooks),
      commands: strings(c.commands),
      workflows: strings(c.workflows),
    },
    bytes,
  };
}

/**
 * Read a chosen file into the preview, or its refusal into the refusal.
 *
 * @param file the chosen .zip
 */
export async function openBundle(file: Blob): Promise<void> {
  set({ busy: true, refusal: null, server: null, preview: null, imported: null });
  try {
    set({ preview: await readPlaybookBundle(file), busy: false });
  } catch (e) {
    const refusal =
      (e as BundleRefusal).key !== undefined
        ? (e as BundleRefusal)
        : refuse("pb.bundle.err.notZip", { detail: String(e) });
    set({ refusal, busy: false });
  }
}

/** Close the preview and forget its refusals. */
export function clearBundle(): void {
  set({ preview: null, refusal: null, server: null, busy: false });
}

/** The server's refusal from a response body, the status when it has no sentence. */
async function serverRefusal(res: Response): Promise<ServerRefusal> {
  const body = (await res.json().catch(() => ({}))) as {
    reason?: unknown;
    message?: unknown;
    findings?: unknown;
  };
  const findings = Array.isArray(body.findings)
    ? body.findings
        .filter((f): f is { path: unknown; message: unknown } => typeof f === "object" && f !== null)
        .map((f) => ({ path: String(f.path ?? ""), message: String(f.message ?? "") }))
    : [];
  return {
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    message: typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`,
    findings,
  };
}

/**
 * Write the previewed bundle into an empty folder. On success the folder joins
 * the known list and the preview closes; on a refusal the preview stays and
 * the server's sentence is kept.
 *
 * @param dir       the folder the owner picked
 * @param workspace the workspace the loaded view resolves skills against
 * @return the folder the server wrote, or null on a refusal
 */
export async function importBundleInto(dir: string, workspace: string | null): Promise<string | null> {
  const preview = state.preview;
  if (preview === null) return null;
  set({ busy: true, server: null });
  let res: Response;
  try {
    res = await fetch("/api/playbooks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, workspace: workspace ?? "", entries: preview.entries }),
    });
  } catch (e) {
    set({ busy: false, server: { message: e instanceof Error ? e.message : String(e), findings: [] } });
    return null;
  }
  if (!res.ok) {
    set({ busy: false, server: await serverRefusal(res) });
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { dir?: unknown };
  const written = typeof body.dir === "string" && body.dir !== "" ? body.dir : dir;
  noteFolder(written);
  set({ busy: false, preview: null, refusal: null, server: null, imported: written });
  return written;
}

/** How a saved file reaches the disk; a seam for tests. */
type Saver = (blob: Blob, name: string) => void;

const saveWithAnchor: Saver = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

let saver: Saver = saveWithAnchor;

/** The file name of a Content-Disposition header, or the fallback. */
function fileNameOf(header: string | null, fallback: string): string {
  const m = header === null ? null : /filename="([^"]+)"/.exec(header);
  return m === null ? fallback : m[1];
}

/**
 * Export a registered folder: the server's ZIP is saved under the name it
 * gives. A refusal is kept with its sentence and findings.
 *
 * @param dir the registered folder
 */
export async function exportBundle(dir: string): Promise<void> {
  set({ exportRefusal: null });
  let res: Response;
  try {
    res = await fetch(`/api/playbooks/export?dir=${encodeURIComponent(dir)}`);
  } catch (e) {
    set({ exportRefusal: { message: e instanceof Error ? e.message : String(e), findings: [] } });
    return;
  }
  if (!res.ok) {
    set({ exportRefusal: await serverRefusal(res) });
    return;
  }
  saver(await res.blob(), fileNameOf(res.headers.get("Content-Disposition"), "playbook.playbook.zip"));
}

/** Test seam: replace how a file is saved. */
export function __setSaver(next: Saver): void {
  saver = next;
}

/** Test seam: forget everything. */
export function __resetBundle(): void {
  saver = saveWithAnchor;
  state = IDLE;
  for (const l of listeners) l();
}

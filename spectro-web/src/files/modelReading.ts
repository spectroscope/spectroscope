// Card 604: the model's answer, read and merged into the ledger. The answer is
// untrusted text: only the asked-for JSON counts, and only its entries on shell
// calls of the ledger land, because a file tool already says exactly which file
// it touched (C14). A path the heuristic named on the same call merges into
// that touch, so the file counts stay and the tag shows both sources (C7).

import type { FileCall, FileLedger, FileTouch } from "./fold";
import { resolvePath } from "./paths";
import type { TouchKind } from "./shell";

export interface ModelEntry {
  callIndex: number;
  path: string;
  kind: TouchKind;
  reason: string;
}

/** From the most specific kind to the least: a merge keeps the earlier one. */
const SPECIFIC: readonly TouchKind[] = [
  "create",
  "delete",
  "overwrite",
  "append",
  "change",
  "write",
  "read",
  "unknown",
];
const KINDS: ReadonlySet<string> = new Set(SPECIFIC);

/**
 * The model's entries, or null when the text is not the JSON contract: an
 * object `{"files":[...]}` or a bare array, either one optionally inside a
 * code fence. Prose around the JSON makes it prose. Entries without an integer
 * call index, a path or a known kind are dropped.
 */
export function readModelAnswer(text: string): ModelEntry[] | null {
  let body = text.trim();
  const fence = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body);
  if (fence !== null) body = fence[1].trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : filesOf(parsed);
  if (list === null) return null;
  const entries: ModelEntry[] = [];
  for (const item of list) {
    const entry = entryOf(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * The ledger with the model's entries added. An entry for a call that is not
 * a shell call of the ledger, for a failed call, or with a kind outside
 * TouchKind is dropped. Its path resolves against that call's base; when a
 * touch of the same call has that path, the entry merges into it: the more
 * specific kind, the reason gains the model's, and the sources gain `model`.
 * Any other entry adds a touch of the model's own. The input is not changed.
 */
export function mergeModel(ledger: FileLedger, entries: readonly ModelEntry[]): FileLedger {
  const shells = new Map<number, FileCall>();
  for (const call of ledger.calls)
    if (call.shell && call.status !== "failed") shells.set(call.callIndex, call);
  const touched = new Map<number, FileTouch[]>();
  for (const entry of entries) {
    const call = shells.get(entry.callIndex);
    if (call === undefined || !KINDS.has(entry.kind) || entry.path === "") continue;
    let touches = touched.get(call.callIndex);
    if (touches === undefined) {
      touches = [...call.touches];
      touched.set(call.callIndex, touches);
    }
    const path = resolvePath(entry.path, call.base);
    const key = keyOf(path);
    const at = touches.findIndex((touch) => keyOf(touch.path) === key);
    if (at < 0) {
      touches.push({
        written: entry.path,
        path,
        folder: entry.path.endsWith("/"),
        kind: entry.kind,
        reason: entry.reason,
        sources: ["model"],
        callIndex: call.callIndex,
        agentId: call.agentId,
        t: call.t,
      });
      continue;
    }
    const touch = touches[at];
    const before = touch.sources.includes("model");
    touches[at] = {
      ...touch,
      kind: specific(touch.kind, entry.kind),
      reason:
        entry.reason === "" ? touch.reason : `${touch.reason}; ${before ? "" : "model: "}${entry.reason}`,
      sources: before ? touch.sources : [...touch.sources, "model"],
    };
  }
  if (touched.size === 0) return ledger;
  return {
    ...ledger,
    calls: ledger.calls.map((call) => {
      const touches = touched.get(call.callIndex);
      return touches === undefined ? call : { ...call, touches };
    }),
  };
}

/** The comparison key of a path: `.` and `..` folded even where no base is known. */
const keyOf = (path: string) => resolvePath(path, ".");

const specific = (a: TouchKind, b: TouchKind): TouchKind =>
  SPECIFIC.indexOf(b) < SPECIFIC.indexOf(a) ? b : a;

function filesOf(parsed: unknown): unknown[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const files = (parsed as { files?: unknown }).files;
  return Array.isArray(files) ? files : null;
}

function entryOf(item: unknown): ModelEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const { callIndex, path, kind, reason } = item as Record<string, unknown>;
  if (typeof callIndex !== "number" || !Number.isInteger(callIndex)) return null;
  if (typeof path !== "string" || path.trim() === "") return null;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  return {
    callIndex,
    path: path.trim(),
    kind: kind as TouchKind,
    reason: typeof reason === "string" ? reason : "",
  };
}

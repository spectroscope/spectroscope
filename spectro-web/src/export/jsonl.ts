// Saving an event stream that only ever existed in this tab (owner 2026-07-27,
// on the translated-session redesign: "und auch gerne anbieten das neue jsonl zu
// exportieren, dann kann man beim nächsten mal gleich das neue nehmen").
//
// WHY THIS IS NOT AN ENDPOINT. There is already a session export — GET
// /api/sessions/{id}/export, which reads a STORED file and serves it verbatim.
// It cannot serve this: a translated stream, and an imported one, were never
// written to ~/.spectro/sessions, so the server has no copy and no id to look
// one up by. Posting the array up so the server can hand the same bytes back
// would buy nothing and cost three things: a new write-shaped endpoint behind
// the local fence, a body bound to argue about, and — the real objection — it
// would push the WHOLE record through the server. The translation path
// deliberately sends prose only; tool output, file paths and commands stay in
// the browser. An export that shipped them to the server to get a download URL
// would undo that on the way out. The array is here, the bytes are here, the
// save is a Blob.
//
// The complement is a different feature, not this one: adopting a translated
// stream INTO the store, so it appears in the sidebar. That is a server write,
// with the store's id minting and its fences, and it is not what a download is.
//
// BYTE COMPATIBILITY is the whole point of the file. The JSONL wire format is
// shared with the Java core (SessionStore.append writes Jackson's
// writeValueAsString + "\n") and with the Python edition, and it is what
// detectAndLoad reads back. Measured against every session on this machine —
// 8,882 lines across 81 files — JSON.parse followed by JSON.stringify returns
// the original line character for character, because JavaScript preserves the
// insertion order of string keys and neither side reformats numbers. So the
// writer is the identity, and the test pins that against real stored lines.
//
// Provenance lives in the FILE NAME, never in an event: events.ts is a frozen
// contract, and a translated stream is still plain RunEvents.

import type { RunEvent } from "../events";
import { isWireEvent } from "../wire/nonWire";

/** The type the server's own export sends, so both save the same kind of file. */
const NDJSON = "application/x-ndjson;charset=utf-8";

/** Long enough for a session id and an imported file name, short enough that
 *  the download does not arrive with a 200-character name. */
const MAX_BASE_CHARS = 64;
/** A language tag, not a sentence: "pt-br" is the long end of honest input. */
const MAX_LANG_CHARS = 12;

/**
 * One event per line, terminated — the exact shape SessionStore writes and
 * detectAndLoad reads.
 *
 * Frames that are not wire events are left out. The stream a tab holds is
 * wider than the file format: the app's own socket-only announcements ride in
 * it, and an import adds the kinds it read out of somebody else's transcript.
 * Writing one of those produces a line the Java reader drops in silence
 * (nonWire.ts has the measurement), so the file would arrive one line shorter
 * than it looks and never say which line went missing.
 *
 * @param events the stream to serialize, in wire order
 * @return the file contents, or "" when nothing wire-shaped survives the filter
 *         (an empty file, not a blank line)
 * @throws TypeError when a value cannot survive JSON (a non-finite number above all)
 */
export function toJsonl(events: readonly RunEvent[]): string {
  const wire = events.filter(isWireEvent);
  if (wire.length === 0) return "";
  return `${wire.map((event) => JSON.stringify(event, refuseNonFinite)).join("\n")}\n`;
}

/**
 * The name the file arrives under. It says what it is (a .jsonl session), which
 * session it came from, which shape it was written in, and which language it was
 * translated into — so a folder of exports is still readable a month later.
 *
 * `marker` is appended AFTER the base is capped, which is the whole point of it
 * being a separate argument: a caller that folds the marker into `base` loses it
 * to the cap, and two formats of one session then arrive under one name and
 * overwrite each other. The cap keeps the base sane; it is not a filesystem
 * limit, so the marker is allowed to sit outside it.
 *
 * @param opts.base   the session id, or an imported file's name; untrusted
 * @param opts.marker the format's own segment, already safe; "" for the app's shape
 * @param opts.lang   the target language tag; omit entirely when nothing was translated
 * @param opts.at     the clock for the fallback stamp (defaults to now)
 * @return `<base><marker>.translated-<lang>.jsonl`, degrading honestly on each missing part
 */
export function jsonlFilename(opts: {
  base?: string | null;
  marker?: string | null;
  lang?: string | null;
  at?: Date;
}): string {
  const capped = safeBase(opts.base) ?? stamp(opts.at ?? new Date());
  const base = `${capped}${typeof opts.marker === "string" ? opts.marker : ""}`;
  if (opts.lang === undefined || opts.lang === null) return `${base}.jsonl`;
  const lang = safeLang(opts.lang);
  // A blank target still means "this is a translation" — it just cannot say
  // into what, and inventing a language tag would be a lie in a file name.
  return lang === "" ? `${base}.translated.jsonl` : `${base}.translated-${lang}.jsonl`;
}

/**
 * Save the stream as a file. The only side effect in this module, isolated
 * behind one seam so everything above it stays testable without a DOM.
 *
 * @param events   the stream to write
 * @param filename the download name, from {@link jsonlFilename}
 * @return how many LINES were written, which is the count of wire events in
 *         the stream rather than its length: a status line that counted the
 *         frames on screen would over-report an imported session by exactly
 *         the frames the file cannot carry
 */
export function downloadJsonl(events: readonly RunEvent[], filename: string): number {
  const text = toJsonl(events);
  save(text, filename);
  return text === "" ? 0 : text.trimEnd().split("\n").length;
}

/** A JSON.stringify replacer that fails loudly instead of writing `null`.
 *  NaN and Infinity are the one corruption JSON.stringify performs silently,
 *  and a `"ts":null` would be read on the Java side as a real timestamp. */
function refuseNonFinite(key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`cannot write ${key || "value"}: ${String(value)} is not JSON`);
  }
  return value;
}

/** The base name, or null when nothing usable survives. The input can be a file
 *  name someone else chose, so it never reaches the save dialog as it arrived:
 *  separators, quotes and control characters all collapse to a dash. */
function safeBase(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/\.jsonl$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, MAX_BASE_CHARS)
    .replace(/[-.]+$/, "");
  return cleaned === "" ? null : cleaned;
}

function safeLang(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, MAX_LANG_CHARS)
    .replace(/-+$/, "");
}

/** Wall-clock stamp in the store's own shape (local time, like the session ids
 *  it will sit beside in a folder), for a stream that never had an id. */
function stamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `spectroscope-session-${date}-${time}`;
}

type Saver = (text: string, filename: string) => void;

const browserSave: Saver = (text, filename) => {
  const url = URL.createObjectURL(new Blob([text], { type: NDJSON }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  // Firefox only follows a click on an anchor that is in the document.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same tick has cancelled the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

let save: Saver = browserSave;

/** Test-only: capture the save instead of performing it (the suite has no DOM). */
export function __setTestHooks(hooks: { save?: Saver }): void {
  if (hooks.save) save = hooks.save;
}

/** Test-only: put the real browser saver back. */
export function __resetForTests(): void {
  save = browserSave;
}

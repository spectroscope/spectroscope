// Card 473: what an import finds beside a session, and where it looks for it.
//
// A spectroscope session names its sidecar files in the main agent's
// `run_start` (three optional fields): the llm wire, the browser wire and the
// child session files. A wire is named only when the writer records it, a
// browser wire only once it was written. A session from before the fields
// resolves by the id convention the recorders use, `<id>.llm.jsonl` and
// `<id>.browser.jsonl`, with the id taken from the file's own name.
//
// Three sources, in order:
//   1. the bundle's own entries (<id>.spectro.zip, from the server's bundle
//      export),
//   2. the files dropped or picked together with a plain JSONL,
//   3. for a plain JSONL (never a bundle) whose wire is on this machine, the
//      server's wire folder, asked by the referenced name. This is the only source that
//      leaves the browser, so a name of any other shape is never asked for:
//      no slash, no dot segment, nothing but `<id>.llm.jsonl` with an id of
//      the store's shape.
//
// A wire that was never written is reported as none and never asked for; a
// wire that was named or expected and did not come is reported as not found.

import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { readZip, sliceClock, type SliceOptions, type ZipEntryBytes } from "./bundleZip";
import { holdWires, readBrowserWire, readLlmWire, type HeldWires, type ReadOptions } from "../wire/heldWire";

/** A file the import was handed: its name and its text. */
export interface NamedText {
  name: string;
  text: string;
}

/** What came with the session file, before anything is resolved. */
export interface ImportWires {
  /** The session file's own name, for the id convention; null for a paste. */
  sessionFileName: string | null;
  llm: NamedText | null;
  browser: NamedText | null;
  children: NamedText[];
  /** "bundle" when the files came out of a .spectro.zip. */
  from: "bundle" | "files";
}

/** The file reference of a session's main run_start lines, read tolerantly. */
export interface WireRef {
  llmWire?: string;
  browserWire?: string;
  children: string[];
}

/** Where a resolved wire came from. "local" is the server's wire folder. */
export type WireOrigin = "bundle" | "files" | "local";

/** What the import found, for the sentence it says. */
export interface FoundReport {
  llm: { name: string; from: WireOrigin; count: number } | null;
  browser: { name: string; from: WireOrigin; count: number } | null;
  children: number;
  /** The wires the session never wrote: reported as none, never asked for. */
  none: ("llm" | "browser")[];
  /** The referenced or expected files that did not come, by name. */
  missing: string[];
}

/** The id shape the store and both recorders mint: never a path, never a dot. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const WIRE_NAME = {
  llm: /^([A-Za-z0-9][A-Za-z0-9-]*)\.llm\.jsonl$/,
  browser: /^([A-Za-z0-9][A-Za-z0-9-]*)\.browser\.jsonl$/,
} as const;

/**
 * The reference a session carries, or null for a session written before the
 * fields existed. Read from the main agent's run_start lines that carry a
 * child list: the first name of each wire wins and the child lists are
 * joined, since a later run_start names only a wire that appeared after the
 * first one (as SessionBundle reads it on the server).
 */
export function wireRefOf(events: readonly RunEvent[]): WireRef | null {
  let ref: WireRef | null = null;
  for (const e of events) {
    if (e.type !== "run_start" || e.parentId !== undefined) continue;
    const v = e as unknown as Record<string, unknown>;
    if (!Array.isArray(v.children)) continue;
    ref ??= { children: [] };
    if (ref.llmWire === undefined && typeof v.llmWire === "string") ref.llmWire = v.llmWire;
    if (ref.browserWire === undefined && typeof v.browserWire === "string") ref.browserWire = v.browserWire;
    for (const c of v.children) if (typeof c === "string") ref.children.push(c);
  }
  return ref;
}

/**
 * The session id inside a wire's file name, or null for any other shape.
 *
 * @param name  the file name the reference gave
 * @param which which wire the name must be
 */
export function wireIdOf(name: string, which: "llm" | "browser"): string | null {
  return WIRE_NAME[which].exec(name)?.[1] ?? null;
}

/** The session id in a session file's name (`<id>.jsonl`), or null. */
export function sessionIdOfFileName(name: string): string | null {
  if (!name.endsWith(".jsonl")) return null;
  const base = name.slice(0, -".jsonl".length);
  return SESSION_ID.test(base) ? base : null;
}

/**
 * Which picked or dropped files are a bundle or a wire. Everything else stays
 * for the existing grouping (a session, or a Claude Code run with its agents).
 *
 * @param names the files' names, in pick order
 * @return the index of the first bundle and of each wire, and the rest
 */
export function sortPickedNames(names: readonly string[]): {
  bundle: number | null;
  llm: number | null;
  browser: number | null;
  rest: number[];
} {
  let bundle: number | null = null;
  let llm: number | null = null;
  let browser: number | null = null;
  const rest: number[] = [];
  names.forEach((name, i) => {
    if (name.endsWith(".spectro.zip")) bundle ??= i;
    else if (name.endsWith(".llm.jsonl")) llm ??= i;
    else if (name.endsWith(".browser.jsonl")) browser ??= i;
    else rest.push(i);
  });
  return { bundle, llm, browser, rest };
}

/**
 * The session and its files out of a bundle's entries. The session is the one
 * top-level .jsonl that is no wire; child sessions sit under `children/`.
 *
 * @throws when the bundle carries no session file, or more than one
 */
export function unpackBundle(entries: readonly ZipEntryBytes[]): { session: NamedText; wires: ImportWires } {
  const decode = new TextDecoder("utf-8");
  return unpackNamed(entries.map((e) => ({ name: e.name, text: decode.decode(e.bytes) })));
}

/** Text decoded a megabyte at a time, with a tick after each, so a 50 MB
 *  entry is never decoded in one task. */
async function decodeSliced(bytes: Uint8Array, tick: (n: number) => Promise<void>): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  const step = 1024 * 1024;
  for (let start = 0; start < bytes.length; start += step) {
    const end = Math.min(bytes.length, start + step);
    parts.push(decoder.decode(bytes.subarray(start, end), { stream: true }));
    await tick(end - start);
  }
  parts.push(decoder.decode());
  return parts.join("");
}

/** The session and its files out of a bundle's decoded entries. */
function unpackNamed(named: readonly NamedText[]): { session: NamedText; wires: ImportWires } {
  const top = named.filter((e) => !e.name.includes("/"));
  const sessions = top.filter(
    (e) => e.name.endsWith(".jsonl") && !e.name.endsWith(".llm.jsonl") && !e.name.endsWith(".browser.jsonl"),
  );
  if (sessions.length !== 1) throw new Error("the bundle carries no single session file");
  const session = sessions[0];
  return {
    session,
    wires: {
      sessionFileName: session.name,
      llm: top.find((e) => e.name.endsWith(".llm.jsonl")) ?? null,
      browser: top.find((e) => e.name.endsWith(".browser.jsonl")) ?? null,
      children: named
        .filter((e) => e.name.startsWith("children/") && e.name.endsWith(".jsonl"))
        .map((e) => ({ name: e.name.slice("children/".length), text: e.text })),
      from: "bundle",
    },
  };
}

/** A picked or dropped file, as far as the import reads it. */
export interface PickedFileLike {
  name: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The spectroscope part of a pick or a drop: a bundle, or a session file with
 * its wires beside it. The session is the .jsonl whose id the wire names, or
 * the only .jsonl there is; every other .jsonl of the drop is a child session.
 *
 * @param files   what was picked or dropped
 * @param options slicing and progress for a bundle's read
 * @return the session and what came with it, or null when the pick holds
 *         neither a bundle nor a wire, so the existing grouping takes it
 * @throws when a bundle does not read, or wires came without one session
 */
export async function readSpectroPick(
  files: readonly PickedFileLike[],
  options: SliceOptions = {},
): Promise<{ session: NamedText; wires: ImportWires } | null> {
  const sorted = sortPickedNames(files.map((f) => f.name));
  if (sorted.bundle !== null) {
    // Checked, then decoded, both in slices: progress runs over the
    // uncompressed bytes twice, once for each pass.
    const bytes = new Uint8Array(await files[sorted.bundle].arrayBuffer());
    const entries = await readZip(bytes, {
      ...options,
      onProgress: (done, total) => options.onProgress?.(done, 2 * total),
    });
    const total = entries.reduce((n, e) => n + e.bytes.length, 0);
    const clock = sliceClock(2 * total, options, total);
    const named: NamedText[] = [];
    for (const e of entries) named.push({ name: e.name, text: await decodeSliced(e.bytes, clock.tick) });
    if (total > 0) options.onProgress?.(2 * total, 2 * total);
    return unpackNamed(named);
  }
  if (sorted.llm === null && sorted.browser === null) return null;
  const read = async (i: number | null): Promise<NamedText | null> =>
    i === null ? null : { name: files[i].name, text: await files[i].text() };
  const llm = await read(sorted.llm);
  const browser = await read(sorted.browser);
  const jsonl = sorted.rest.filter((i) => files[i].name.endsWith(".jsonl"));
  const wireId =
    (llm === null ? null : wireIdOf(llm.name, "llm")) ??
    (browser === null ? null : wireIdOf(browser.name, "browser"));
  const named = jsonl.find((i) => sessionIdOfFileName(files[i].name) === wireId);
  const sessionAt = named ?? (jsonl.length === 1 ? jsonl[0] : undefined);
  if (sessionAt === undefined) throw new Error("the wires came without one session file");
  const children: NamedText[] = [];
  for (const i of jsonl)
    if (i !== sessionAt) children.push({ name: files[i].name, text: await files[i].text() });
  const session = { name: files[sessionAt].name, text: await files[sessionAt].text() };
  return { session, wires: { sessionFileName: session.name, llm, browser, children, from: "files" } };
}

/** Asks the server for a text; null for every way of not getting one. */
export async function fetchLocalText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the wires of an imported spectroscope session: the ones that came
 * with it, and for each one that did not, the server's wire folder when the
 * session names one of a safe shape.
 *
 * @param events    the session's events
 * @param wires     what came with the session file
 * @param fetchText how the server is asked; injected for the tests
 * @return the wire texts with their origins, the child sessions that came, and
 *         the report (wire counts are filled in once the wires are read)
 */
export async function resolveImportWires(
  events: readonly RunEvent[],
  wires: ImportWires,
  fetchText: (url: string) => Promise<string | null> = fetchLocalText,
): Promise<{
  llm: (NamedText & { from: WireOrigin }) | null;
  browser: (NamedText & { from: WireOrigin }) | null;
  children: NamedText[];
  report: FoundReport;
}> {
  const ref = wireRefOf(events);
  const ownId =
    (wires.sessionFileName === null ? null : sessionIdOfFileName(wires.sessionFileName)) ??
    (ref?.llmWire === undefined ? null : wireIdOf(ref.llmWire, "llm")) ??
    (ref?.browserWire === undefined ? null : wireIdOf(ref.browserWire, "browser"));
  // What the session's own lines say was written: a closed exchange reaches
  // the file as an llm_exchange line, and every agent browser call as a
  // browser_action line.
  const wrote = {
    llm: events.some((e) => e.type === "llm_exchange"),
    browser: events.some((e) => e.type === "browser_action"),
  };
  // The name each wire is expected under: the reference's when it names one.
  // A wire the reference leaves unnamed was never written, unless the
  // session's lines say it was (a page opened after the last run_start).
  // Without a reference the convention's name is expected, for the llm wire
  // always and for the browser wire when the session made a browser call. No
  // id at all (a paste of an old session) means nothing is expected and
  // nothing is asked.
  const expected = (which: "llm" | "browser"): string | null | "none" => {
    const named = ref === null ? undefined : which === "llm" ? ref.llmWire : ref.browserWire;
    if (named !== undefined) return named;
    const byConvention = ownId !== null ? `${ownId}.${which}.jsonl` : null;
    if (wrote[which]) return byConvention;
    if (ref === null && which === "llm") return byConvention;
    return byConvention === null && ref === null ? null : "none";
  };
  const missing: string[] = [];
  const none: ("llm" | "browser")[] = [];
  const resolve = async (which: "llm" | "browser"): Promise<(NamedText & { from: WireOrigin }) | null> => {
    const came = which === "llm" ? wires.llm : wires.browser;
    if (came !== null) return { ...came, from: wires.from };
    const name = expected(which);
    if (name === null) return null;
    if (name === "none") {
      none.push(which);
      return null;
    }
    const id = wireIdOf(name, which);
    // A bundle is the other machine's whole record: what it does not carry
    // did not exist there, so this machine is asked only for a plain file.
    const text =
      id === null || wires.from === "bundle"
        ? null
        : await fetchText(`/api/sessions/${encodeURIComponent(id)}/${which}-wire`);
    if (text === null) {
      missing.push(name);
      return null;
    }
    return { name, text, from: "local" };
  };
  const llm = await resolve("llm");
  const browser = await resolve("browser");
  const childNames = new Set(wires.children.map((c) => c.name));
  for (const child of ref?.children ?? []) {
    if (!childNames.has(`${child}.jsonl`)) missing.push(`${child}.jsonl`);
  }
  return {
    llm,
    browser,
    children: wires.children,
    report: {
      llm: llm === null ? null : { name: llm.name, from: llm.from, count: 0 },
      browser: browser === null ? null : { name: browser.name, from: browser.from, count: 0 },
      children: wires.children.length,
      none,
      missing,
    },
  };
}

/**
 * Resolves, reads and holds the wires of one imported spectroscope session,
 * under the import's own session id, so the readers that ask by id (the
 * trace's merge, the open exchange, the browser replay) answer from them.
 * Read in slices under the opening sign; progress counts the characters of
 * both wires together.
 *
 * @param sessionId the import's session id (the replay id)
 * @param events    the session's events
 * @param wires     what came with the session file
 * @param options   slicing, progress and supersession for the read
 * @param fetchText how the server is asked; injected for the tests
 * @return the report with the read counts, or null when a later navigation
 *         superseded the import (nothing is held then)
 */
export async function holdImportWires(
  sessionId: string,
  events: readonly RunEvent[],
  wires: ImportWires,
  options: ReadOptions = {},
  fetchText: (url: string) => Promise<string | null> = fetchLocalText,
): Promise<FoundReport | null> {
  const got = await resolveImportWires(events, wires, fetchText);
  if (options.isCurrent !== undefined && !options.isCurrent()) return null;
  const total = (got.llm?.text.length ?? 0) + (got.browser?.text.length ?? 0);
  let base = 0;
  const sliced: ReadOptions = {
    ...options,
    onProgress: (done) => options.onProgress?.(base + done, total),
  };
  const held: HeldWires = {};
  if (got.llm !== null) {
    const llm = await readLlmWire(got.llm.text, sliced);
    if (llm === null) return null;
    held.llm = llm;
    base += got.llm.text.length;
  }
  if (got.browser !== null) {
    const browser = await readBrowserWire(got.browser.text, sliced);
    if (browser === null) return null;
    held.browser = browser;
  }
  // Checked once more right before holding: a later import may have started
  // while the last slice ran, and it must not lose its own wires to this one.
  if (options.isCurrent !== undefined && !options.isCurrent()) return null;
  holdWires(sessionId, held);
  return {
    ...got.report,
    llm: got.report.llm === null ? null : { ...got.report.llm, count: held.llm?.index.length ?? 0 },
    browser:
      got.report.browser === null ? null : { ...got.report.browser, count: held.browser?.index.length ?? 0 },
  };
}

/** How many names from an imported file the sentence repeats, and how long
 *  each may be: the names are the file's data, so a hostile or merely
 *  enormous file cannot flood the bar (import/detect.ts caps type names the
 *  same way). */
const MAX_REPORTED_NAMES = 5;
const MAX_NAME_CHARS = 64;

/** A name from an imported file, flattened to one line and capped. */
function safeName(raw: string): string {
  // C0, DEL, C1 and the two Unicode line separators: everything a renderer
  // could read as "start a new line".
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").trim();
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS)}…` : flat;
}

/**
 * The one sentence the import says about what came with the session.
 *
 * @param lang   the chrome language
 * @param report what was found, with the read counts filled in
 */
export function foundSentence(lang: Lang, report: FoundReport): string {
  const local = (from: WireOrigin): string => (from === "local" ? t(lang, "imp.found.local") : "");
  const parts = [t(lang, "imp.found.session")];
  if (report.llm !== null) {
    parts.push(
      t(lang, report.llm.count === 1 ? "imp.found.llmOne" : "imp.found.llm", { n: report.llm.count }) +
        local(report.llm.from),
    );
  } else if (report.none.includes("llm")) {
    parts.push(t(lang, "imp.found.llmNone"));
  }
  if (report.browser !== null) {
    parts.push(
      t(lang, report.browser.count === 1 ? "imp.found.browserOne" : "imp.found.browser", {
        n: report.browser.count,
      }) + local(report.browser.from),
    );
  } else if (report.none.includes("browser")) {
    parts.push(t(lang, "imp.found.browserNone"));
  }
  parts.push(
    t(lang, report.children === 1 ? "imp.found.childrenOne" : "imp.found.children", { n: report.children }),
  );
  const said = [t(lang, "imp.found.lead", { list: parts.join(", ") })];
  if (report.missing.length > 0) {
    const names = report.missing.slice(0, MAX_REPORTED_NAMES).map(safeName).join(", ");
    const more = report.missing.length - MAX_REPORTED_NAMES;
    said.push(
      more > 0
        ? t(lang, "imp.found.missingMore", { names, n: more })
        : t(lang, "imp.found.missing", { names }),
    );
  } else if (report.llm === null && report.browser === null && report.none.length === 0)
    said.push(t(lang, "imp.found.noWire"));
  return said.join(" ");
}

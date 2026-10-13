// Card 554, task 13, integrator decision a: the playbook commands the chat
// answers on the page, never with a frame of their own.
//
// /playbook names the current playbook, its folder and where it comes from:
// the session's pick, the playbook pinned for the workspace (a suggestion,
// card 554 owner answer 5), the explicit "No playbook" (decision b), or none.
// /playbook list names the registered folders and marks the current one.
// /playbook show [name] summarises one: its steps with their models, its
// gates, its models and the counts of what it brings. /playbook use <name>
// resolves a playbook name, a folder name or a folder path to one registered
// folder; an unknown or ambiguous name is refused with the candidates.
//
// The text builders are pure and take the page's language. The three reads
// ask the server the routes the Playbook view asks (state/playbooks.ts) and
// leave that view's store alone.

import { t, type Lang } from "../i18n/i18n";
import type { PlaybookPick } from "./playbookChat";
import type { LoadedPlaybook } from "./playbooks";

/** The registered playbook folders and the one pinned for the workspace. */
export interface PlaybookFolderFacts {
  folders: string[];
  pinned: string | null;
}

/** A registered folder and the name its playbook gives; null when it does not load. */
export interface NamedFolder {
  dir: string;
  name: string | null;
}

/** The playbook a session works with, and where that comes from. */
export type CurrentPlaybook =
  | { source: "picked"; dir: string; name: string | null; found: boolean | null }
  | { source: "suggested"; dir: string }
  | { source: "none" }
  | { source: "nothing" };

/** A name resolved to one folder, or the line that refuses it. */
export type Resolution = { dir: string; name: string } | { refusal: string };

/** The last part of a folder path. */
export function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? dir;
}

/**
 * The session's playbook in the server's order: the pick, else the explicit
 * none, else the folder pinned for the workspace.
 *
 * @param pick   the session's pick (UiState.playbook), or null before any frame
 * @param pinned the folder pinned for the workspace, or null
 */
export function currentOf(pick: PlaybookPick | null, pinned: string | null): CurrentPlaybook {
  if (pick !== null && pick.dir !== null) {
    return { source: "picked", dir: pick.dir, name: pick.name, found: pick.found };
  }
  if (pick?.none === true) return { source: "none" };
  return pinned !== null ? { source: "suggested", dir: pinned } : { source: "nothing" };
}

/**
 * What /playbook answers.
 *
 * @param current the session's playbook
 * @param name    the suggested playbook's name, when it was read; a pick brings its own
 * @param lang    the page's language
 */
export function currentLine(current: CurrentPlaybook, name: string | null, lang: Lang): string {
  switch (current.source) {
    case "picked": {
      const title =
        current.found === false
          ? t(lang, "pbcmd.current.notFound")
          : t(lang, "pbcmd.current", { name: current.name ?? folderName(current.dir) });
      return [title, t(lang, "pbcmd.folder", { dir: current.dir }), t(lang, "pbcmd.source.picked")].join(
        "\n",
      );
    }
    case "suggested":
      return [
        t(lang, "pbcmd.current", { name: name ?? folderName(current.dir) }),
        t(lang, "pbcmd.folder", { dir: current.dir }),
        t(lang, "pbcmd.source.suggested"),
      ].join("\n");
    case "none":
      return [t(lang, "pbcmd.current.none"), t(lang, "pbcmd.source.none")].join("\n");
    case "nothing":
      return [t(lang, "pbcmd.current.none"), t(lang, "pbcmd.howToPick")].join("\n");
  }
}

/** "name (folder)", the name falling back to the folder's. */
function labelOf(folder: NamedFolder): string {
  return `${folder.name ?? folderName(folder.dir)} (${folder.dir})`;
}

/**
 * What /playbook list answers.
 *
 * @param named   the registered folders with their names
 * @param current the session's playbook, whose folder is marked
 * @param lang    the page's language
 */
export function listLine(named: readonly NamedFolder[], current: CurrentPlaybook, lang: Lang): string {
  if (named.length === 0) return t(lang, "pbcmd.list.empty");
  const mark = (dir: string): string => {
    if (current.source === "picked" && current.dir === dir) return ` ${t(lang, "pbcmd.list.current")}`;
    if (current.source === "suggested" && current.dir === dir) return ` ${t(lang, "pbcmd.list.suggested")}`;
    return "";
  };
  return [t(lang, "pbcmd.list.title"), ...named.map((f) => `- ${labelOf(f)}${mark(f.dir)}`)].join("\n");
}

/**
 * /playbook use: a folder path, a playbook name or a folder name, the case of
 * a name aside, resolved to exactly one registered folder.
 *
 * @param query the words after the command
 * @param named the registered folders with their names
 * @param lang  the page's language
 */
export function resolveName(query: string, named: readonly NamedFolder[], lang: Lang): Resolution {
  const wanted = query.trim();
  if (wanted === "") return { refusal: t(lang, "pbcmd.use.usage") };
  const lower = wanted.toLowerCase();
  const hits = named.filter(
    (f) =>
      f.dir === wanted ||
      (f.name !== null && f.name.toLowerCase() === lower) ||
      folderName(f.dir).toLowerCase() === lower,
  );
  if (hits.length === 1) return { dir: hits[0].dir, name: hits[0].name ?? folderName(hits[0].dir) };
  if (hits.length > 1) {
    return {
      refusal: t(lang, "pbcmd.use.ambiguous", { query: wanted, names: hits.map(labelOf).join(", ") }),
    };
  }
  return named.length === 0
    ? { refusal: t(lang, "pbcmd.use.unknownEmpty", { query: wanted }) }
    : { refusal: t(lang, "pbcmd.use.unknown", { query: wanted, names: named.map(labelOf).join(", ") }) };
}

/**
 * The folder /playbook show summarises: the one named, else the session's.
 *
 * @param query   the words after the command, empty for the session's playbook
 * @param named   the registered folders with their names
 * @param current the session's playbook
 * @param lang    the page's language
 */
export function showTarget(
  query: string,
  named: readonly NamedFolder[],
  current: CurrentPlaybook,
  lang: Lang,
): { dir: string } | { refusal: string } {
  if (query.trim() !== "") {
    const resolved = resolveName(query, named, lang);
    return "refusal" in resolved ? resolved : { dir: resolved.dir };
  }
  if (current.source === "picked" || current.source === "suggested") return { dir: current.dir };
  return { refusal: t(lang, "pbcmd.show.nothing", { how: t(lang, "pbcmd.howToPick") }) };
}

/**
 * What /playbook show answers for a loaded folder.
 *
 * @param loaded the server's reading of the folder
 * @param lang   the page's language
 */
export function showLine(loaded: LoadedPlaybook, lang: Lang): string {
  const p = loaded.playbook;
  if (p === null) {
    const findings = loaded.findings.map((f) => `${f.path}: ${f.message}`).join("; ");
    return t(lang, "pbcmd.show.notLoaded", { dir: loaded.dir, findings });
  }
  const resolved = new Map(loaded.steps.map((s) => [s.id, s.model]));
  const lines = [t(lang, "pbcmd.show.title", { name: p.name }), t(lang, "pbcmd.folder", { dir: loaded.dir })];
  const steps = p.nodes.filter((n) => n.kind === "step");
  if (steps.length > 0) {
    lines.push(t(lang, "pbcmd.show.steps"));
    steps.forEach((step, i) => {
      const model = resolved.get(step.id) ?? null;
      const words = model !== null ? `${model.provider} ${model.model}` : (step.model ?? "?");
      lines.push(`${i + 1}. ${step.name}: ${words}`);
    });
  }
  const gates = p.nodes.filter((n) => n.kind === "decision");
  if (gates.length > 0) {
    lines.push(t(lang, "pbcmd.show.gates"));
    for (const gate of gates) lines.push(`- ${gate.name} (${gate.check})`);
  }
  const models = Object.entries(p.models);
  if (models.length > 0) {
    lines.push(t(lang, "pbcmd.show.models"));
    for (const [key, ref] of models) lines.push(`- ${key}: ${ref.primary.provider} ${ref.primary.model}`);
  }
  const c = p.contents;
  lines.push(
    t(lang, "pbcmd.show.contents", {
      skills: c.skills.length,
      agents: c.agents.length,
      hooks: c.hooks.length,
      commands: c.commands.length,
      workflows: c.workflows.length,
    }),
  );
  return lines.join("\n");
}

/**
 * The registered folders and the pin for a workspace, GET /api/playbooks.
 *
 * @param workspace the session's workspace; null reads no pin
 * @throws Error when the server does not answer
 */
export async function readFolders(workspace: string | null): Promise<PlaybookFolderFacts> {
  const url =
    workspace === null ? "/api/playbooks" : `/api/playbooks?workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { folders?: unknown; active?: unknown };
  return {
    folders: Array.isArray(body.folders)
      ? body.folders.filter((f): f is string => typeof f === "string")
      : [],
    pinned: workspace !== null && typeof body.active === "string" ? body.active : null,
  };
}

/**
 * One registered folder, loaded (GET /api/playbooks/load), or the server's
 * reason it was not.
 *
 * @param dir       the folder
 * @param workspace the workspace the skills and providers resolve against, or null
 */
export async function readLoaded(
  dir: string,
  workspace: string | null,
): Promise<{ loaded: LoadedPlaybook } | { error: string }> {
  const ws = workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(`/api/playbooks/load?dir=${encodeURIComponent(dir)}${ws}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return {
      error: typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`,
    };
  }
  return { loaded: (await res.json()) as LoadedPlaybook };
}

/**
 * Each folder with the name its playbook gives, read in parallel; a folder
 * that does not load has none.
 *
 * @param folders   the registered folders
 * @param workspace the session's workspace, or null
 */
export async function readNames(
  folders: readonly string[],
  workspace: string | null,
): Promise<NamedFolder[]> {
  return Promise.all(
    folders.map(async (dir) => {
      const read = await readLoaded(dir, workspace).catch(() => ({ error: "" }));
      return { dir, name: "loaded" in read ? (read.loaded.playbook?.name ?? null) : null };
    }),
  );
}

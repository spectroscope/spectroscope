// The installed skills, for anything that is not the settings panel (card 183).
//
// A module store rather than a fetch inside the composer, for two reasons. The
// list is wanted LAZILY — a reader who never types `/` should cost no request
// at all — and once fetched it is wanted by whatever asks next without a second
// round trip. Skill edits apply to new sessions anyway, which the settings
// panel says out loud, so a list that is a few minutes old is not a lie.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { SkillOption } from "./slashCommands";

/** Not asked for yet · in flight · what came back · the request failed. */
type State = { status: "idle" | "loading" | "failed"; skills: readonly SkillOption[] };

const NONE: readonly SkillOption[] = [];

let state: State = { status: "idle", skills: NONE };
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  listeners.forEach((wake) => wake());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The row shape `GET /api/skills` answers with, as far as this cares. */
interface SkillRow {
  name?: unknown;
  folder?: unknown;
  pack?: unknown;
  description?: unknown;
  disabled?: unknown;
}

/**
 * Reads one listing row defensively.
 *
 * `folder` and `pack` arrived with the namespaced install (card 182); an older
 * server sends neither, and a bare name is its own folder with no pack. Reading
 * it that way means this works against a server that predates the namespace
 * instead of showing a list of undefined.
 */
function optionOf(row: SkillRow): SkillOption | null {
  if (typeof row.name !== "string" || row.name === "") return null;
  const name = row.name;
  const colon = name.indexOf(":");
  return {
    name,
    folder: typeof row.folder === "string" ? row.folder : colon < 0 ? name : name.slice(colon + 1),
    pack: typeof row.pack === "string" ? row.pack : colon < 0 ? null : name.slice(0, colon),
    description: typeof row.description === "string" ? row.description : "",
    disabled: row.disabled === true,
  };
}

/** Fetches once. A second call while one is in flight, or after one landed,
 *  does nothing — the composer asks on every keystroke that starts with `/`. */
export function loadSkills(): void {
  if (state.status !== "idle") return;
  set({ status: "loading", skills: state.skills });
  fetch("/api/skills")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: unknown) => {
      const rows = (body as { skills?: unknown }).skills;
      const skills = Array.isArray(rows) ? rows.map((r) => optionOf(r as SkillRow)).filter(isOption) : [];
      set({ status: "idle", skills });
    })
    .catch(() => set({ status: "failed", skills: NONE }));
}

function isOption(s: SkillOption | null): s is SkillOption {
  return s !== null;
}

/** Test-only: back to never-asked, so one test cannot answer the next. */
export function __resetSkillList(): void {
  state = { status: "idle", skills: NONE };
}

/** What the store holds right now, without asking for anything. */
export function loadedSkills(): readonly SkillOption[] {
  return state.skills;
}

/**
 * The installed skills, fetched the first time somebody wants them.
 *
 * @param wanted whether the caller needs the list right now
 * @returns the skills, empty until the first answer lands
 */
export function useSkills(wanted: boolean): readonly SkillOption[] {
  const skills = useSyncExternalStore(subscribe, loadedSkills, loadedSkills);
  useEffect(() => {
    if (wanted) loadSkills();
  }, [wanted]);
  return skills;
}

/** The list plus whether it has ever answered — the popover needs to tell
 *  "nothing installed" from "not back yet". */
export function useSkillsWithStatus(wanted: boolean): { skills: readonly SkillOption[]; asked: boolean } {
  const skills = useSkills(wanted);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    const stop = subscribe(() => setAsked(true));
    if (state.status !== "loading") setAsked(true);
    return stop;
  }, [wanted]);
  return { skills, asked };
}

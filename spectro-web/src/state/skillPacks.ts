// Card 410: the catalogue shelf read as packs. The grouping is computed from
// the rows `/api/skills` returned on its latest read and from nothing else, so
// a header's count follows the disk the way the rows do: nothing here is held
// between reads.

import type { CatalogueRow } from "./skillInstall";

/** One pack of the shelf, as its header needs it. */
export interface PackGroup {
  pack: string;
  /** The pack's rows, in the order the catalogue listed them. */
  rows: CatalogueRow[];
  /** Rows either root already carries. */
  installed: number;
  total: number;
  /** What the pack's install button copies: the rows no root carries. */
  missing: CatalogueRow[];
  /** What the pack's remove button takes out: user-root copies only, since a
   *  project-root skill belongs to the repo and the server refuses it. */
  removable: CatalogueRow[];
}

/**
 * @param rows the catalogue as the latest `/api/skills` read returned it
 * @returns one group per pack, packs sorted by name
 */
export function packGroups(rows: readonly CatalogueRow[]): PackGroup[] {
  const byPack = new Map<string, CatalogueRow[]>();
  for (const row of rows) {
    const list = byPack.get(row.pack);
    if (list === undefined) byPack.set(row.pack, [row]);
    else list.push(row);
  }
  return [...byPack.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((pack) => {
      const packRows = byPack.get(pack) ?? [];
      return {
        pack,
        rows: packRows,
        installed: packRows.filter((r) => r.installed).length,
        total: packRows.length,
        missing: packRows.filter((r) => !r.installed),
        removable: packRows.filter((r) => r.installed && r.root === "user"),
      };
    });
}

/** An installed skill as `/api/skills` lists it under `skills`. */
export interface InstalledSkill {
  /** As the agent reads it: `<pack>:<skill>` for a catalogue install, bare otherwise. */
  name: string;
  /** The skill's own folder; the display name is not a path. */
  folder: string;
  /** The pack folder, null for a skill installed at the top level. */
  pack: string | null;
  description: string;
  source: "user" | "project";
  disabled: boolean;
}

/** One namespace of the installed list, as its header needs it (card 411). */
export interface InstalledNamespace {
  /** The pack folder, or null for the skills installed at the top level. */
  namespace: string | null;
  /** The group's rows, in the order the server listed them. */
  rows: InstalledSkill[];
  /** Every row of the group, on or off, from either root. */
  count: number;
}

/**
 * The installed list read as groups (card 411; owner, 2026-09-25: "alle
 * Skills, die ich installiert habe, möchte ich auch eingeklappt haben, so wie
 * unten die Pakete"). Computed from the rows of the latest `/api/skills` read
 * and from nothing else.
 *
 * @param rows the installed skills as the latest `/api/skills` read returned them
 * @returns the skills without a namespace first when there are any, then one
 *   group per namespace, sorted by name
 */
export function installedGroups(rows: readonly InstalledSkill[]): InstalledNamespace[] {
  const bare: InstalledSkill[] = [];
  const byNamespace = new Map<string, InstalledSkill[]>();
  for (const row of rows) {
    if (row.pack === null) {
      bare.push(row);
      continue;
    }
    const list = byNamespace.get(row.pack);
    if (list === undefined) byNamespace.set(row.pack, [row]);
    else list.push(row);
  }
  const named = [...byNamespace.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((namespace): InstalledNamespace => {
      const groupRows = byNamespace.get(namespace) ?? [];
      return { namespace, rows: groupRows, count: groupRows.length };
    });
  return bare.length === 0 ? named : [{ namespace: null, rows: bare, count: bare.length }, ...named];
}

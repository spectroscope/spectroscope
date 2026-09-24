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

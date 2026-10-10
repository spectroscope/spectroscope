// The two folders of the Spectrolyzr wizard (card 484): the playbook folder
// is a sibling of the project folder unless the owner types another, and it
// moves with the project folder and the name while it holds that sibling.

import { suggestPlaybookDir, type LyzrChoices } from "../../state/spectrolyzr";

/** The id of the add-on that writes the spectro playbook. */
export const PLAYBOOK_ADDON = "spectro-playbook";

/** The playbook folder the wizard sends: the one typed, else the sibling of the project folder. */
export function effectivePlaybookDir(c: LyzrChoices): string {
  return c.playbookDir !== "" ? c.playbookDir : suggestPlaybookDir(c.dir, c.name);
}

/**
 * A change to the project folder or the name, with the playbook folder moved
 * along while it still holds the sibling the wizard suggested. A folder the
 * owner typed stays where it is, and an empty one keeps following on its own.
 *
 * @param c     the choices before the change
 * @param patch the change to the folder or the name
 */
export function followingPlaybookDir(c: LyzrChoices, patch: Partial<LyzrChoices>): Partial<LyzrChoices> {
  if (c.playbookDir === "" || c.playbookDir !== suggestPlaybookDir(c.dir, c.name)) return patch;
  const next = { ...c, ...patch };
  return { ...patch, playbookDir: suggestPlaybookDir(next.dir, next.name) };
}

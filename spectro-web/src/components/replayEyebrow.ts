// What the header calls the thing you are reading.
//
// Three kinds of stream take the replay path and they are genuinely different:
// a stored session on this machine, a compiled scenario, and a file imported
// from another tool. An import is not an archive. It was produced elsewhere, it
// lives only in this tab, and it cannot be resumed, appended to or deleted
// (App's `canResume` has always known that; the header did not say it).

/** The dictionary key for a replay id's eyebrow. */
export function replayEyebrow(replayId: string): string {
  if (replayId.startsWith("import:")) return "hdr.imported";
  if (replayId.startsWith("scenario:")) return "hdr.scenario";
  return "hdr.archive";
}

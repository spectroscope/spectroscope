// Card 398: a test build puts its label into the window title.
//
// The desktop window takes its title from document.title, so the page sets it
// once at startup from the label the server reports in /api/bundles. A release
// reports no label and the title stays what index.html says. The desktop shell
// does not read the label; aboutBuildLabel.test.tsx holds it to that.

import { buildLabel, windowTitle } from "../components/about";

/** GET /api/bundles as JSON, or null when the server does not answer with 200. */
function loadBundles(): Promise<unknown> {
  return fetch("/api/bundles").then((r) => (r.ok ? r.json() : null));
}

/**
 * Sets the document title to the test build label when the server reports one.
 * Leaves the title untouched on a release and when the request fails.
 *
 * @param load where the /api/bundles answer comes from
 * @param doc  the object whose title is set
 */
export function applyBuildTitle(
  load: () => Promise<unknown> = loadBundles,
  doc: { title: string } = document,
): Promise<void> {
  return load()
    .then((c) => {
      const label = buildLabel((c as { label?: unknown } | null)?.label);
      if (label !== null) doc.title = windowTitle(label);
    })
    .catch(() => {
      /* offline or an older server: the title stays as index.html has it */
    });
}

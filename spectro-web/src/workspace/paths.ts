// Pure path helpers for the workspace UI — kept out of the components so
// they stay unit-testable, same rationale as preview.ts next door.

/** The folder's display name — the last path segment, for a chip label. */
export function workspaceBasename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

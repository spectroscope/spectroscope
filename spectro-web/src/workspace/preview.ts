// Pure decisions for the workspace preview pane — kept out of the component
// so they are unit-testable: which renderer a file gets, the sandboxed
// content URL, and a compact size label.

export type PreviewKind = "html" | "image" | "markdown" | "text";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKind(path: string): PreviewKind {
  const ext = extension(path);
  if (ext === "html" || ext === "htm") return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "text";
}

/**
 * The sandboxed content endpoint for a workspace-relative path.
 *
 * @param path the root-relative path from the tree
 * @param sessionId the session whose resolved workspace holds the file
 * @param prospective true when the tree above is the folder the first run will
 *   use, so the preview must read from the same root; a session always wins,
 *   because once a run resolves a folder that folder is the answer
 */
export function fileUrl(path: string, sessionId?: string, prospective = false): string {
  const root =
    sessionId !== undefined
      ? `&session=${encodeURIComponent(sessionId)}`
      : prospective
        ? "&scope=prospective"
        : "";
  return `/api/file?path=${encodeURIComponent(path)}${root}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/**
 * Whether the server's hide rule is what refused this path.
 *
 * The check is per SEGMENT and on the prefix, not on "contains a dot": almost
 * every file has a dot in its name, and the tree hands out paths whose hidden
 * segment is a parent (`.claude/launch.json`).
 */
function hiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * The note a failed preview shows, as a dict key.
 *
 * Card 351 split the server's one predicate in two: the tree lists dot-entries
 * and the content endpoint still refuses their bytes. That leaves the operator
 * clicking a name he can see and getting a 404 — which is the same 404 a
 * deleted file gives, so without this the pane would explain a deliberate
 * refusal as a missing file. Only a 404 reads as the hide rule; a dead fetch
 * arrives as 0 and stays what it is.
 *
 * @param status the HTTP status the fetch rejected with, or 0 for a throw
 * @param path the workspace-relative path that was asked for
 */
export function previewNoteKey(status: number, path: string): string {
  if (status === 415) return "ws.binary";
  if (status === 413) return "ws.tooBig";
  if (status === 404 && hiddenSegment(path)) return "ws.hidden";
  return "ws.loadError";
}

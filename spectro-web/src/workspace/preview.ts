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

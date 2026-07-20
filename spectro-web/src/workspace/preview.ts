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

/** The sandboxed content endpoint for a workspace-relative path. */
export function fileUrl(path: string, sessionId?: string): string {
  const session = sessionId === undefined ? "" : `&session=${encodeURIComponent(sessionId)}`;
  return `/api/file?path=${encodeURIComponent(path)}${session}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

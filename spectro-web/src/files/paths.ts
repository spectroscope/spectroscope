// Card 604: path folding for the files tab. Pure string work, nothing here
// reads the disk, so the same input always gives the same key.

/**
 * Joins a relative `written` path onto `base` and folds `.` and `..`. An
 * absolute path (or one under `~`) stays absolute and is only folded. With no
 * base the path comes back exactly as written. A relative base stays relative,
 * so a shell line that moved with `cd` in an unknown folder still says where.
 */
export function resolvePath(written: string, base: string | null): string {
  if (base === null || base === "") return written;
  if (isRooted(written)) return fold(written);
  return fold(base.endsWith("/") ? base + written : `${base}/${written}`);
}

function isRooted(p: string): boolean {
  return p.startsWith("/") || p === "~" || p.startsWith("~/");
}

function fold(p: string): string {
  const root = p.startsWith("/") ? "/" : p === "~" || p.startsWith("~/") ? "~" : "";
  const parts: string[] = [];
  for (const part of p.slice(root.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (root === "") parts.push("..");
  }
  if (root === "/") return "/" + parts.join("/");
  if (root === "~") return ["~", ...parts].join("/");
  return parts.length > 0 ? parts.join("/") : ".";
}

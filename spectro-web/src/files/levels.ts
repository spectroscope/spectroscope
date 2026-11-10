// Card 605: the level of a path the session touched (design section 2 and
// call B1). Pure string work on paths the files tab's fold already resolved:
// absolute where a base was known, otherwise as written.

import { isRooted, resolvePath } from "./paths";

export type Level = "critical" | "sensitive" | "unknown" | "project";

/** Highest first. The verdict of a report is the earliest level it holds. */
export const LEVEL_ORDER: readonly Level[] = ["critical", "sensitive", "unknown", "project"];

/** The higher of two levels, the one earlier in LEVEL_ORDER. */
export function higher(a: Level, b: Level): Level {
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b;
}

// Segments compared in lower case: the default macOS file system opens `.ENV` as `.env`.
// A segment here marks a folder on the way or the name itself.
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", "secrets", "credentials", "keychains"]);
const SECRET_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "kubeconfig",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx"];
const SSH_KEY_NAME = /^id_(?:rsa|ed25519|ecdsa|dsa)/;
const TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

// Call B1: the folders that count as sensitive when no workspace was recorded.
const SYSTEM_FOLDERS = new Set(["etc", "var", "private", "usr", "Library", "System"]);
const HOME_FOLDERS = new Set(["Users", "home"]);

/** True when the path's name or a folder on its way is secret-shaped. */
export function isSecretPath(path: string): boolean {
  const segments = segmentsOf(normal(path)).map((s) => s.toLowerCase());
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  return isSecretName(segments[segments.length - 1] ?? "");
}

/** The level of one path. Never `unknown`: that level belongs to scripts, not to paths. */
export function pathLevel(path: string, workspace: string | null): Level {
  if (isSecretPath(path)) return "critical";
  if (workspaceRoot(workspace) !== null) return outsideWorkspace(path, workspace) ? "sensitive" : "project";
  return isSystemOrHomeDot(normal(path)) ? "sensitive" : "project";
}

/**
 * True when a rooted path lies outside the workspace. False without a
 * workspace, and false for a relative path, which nothing placed.
 */
export function outsideWorkspace(path: string, workspace: string | null): boolean {
  const root = workspaceRoot(workspace);
  if (root === null) return false;
  const p = normal(path);
  if (!isRooted(p)) return false;
  // The separator is required: "/w/p2" is not inside "/w/p".
  return p !== root && !p.startsWith(`${root}/`);
}

// A rooted path gets its `.`, `..` and trailing slashes folded (resolvePath
// folds a rooted path whatever the base). A relative one stays as written.
function normal(path: string): string {
  return isRooted(path) ? resolvePath(path, "/") : path;
}

function segmentsOf(p: string): string[] {
  return p.split("/").filter((s) => s !== "");
}

// A workspace that is missing, empty, the file system root or relative places nothing.
function workspaceRoot(workspace: string | null): string | null {
  if (workspace === null) return null;
  const root = normal(workspace);
  return isRooted(root) && root !== "/" ? root : null;
}

function isSecretName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && TEMPLATE_SUFFIXES.has(name.slice(dot + 1))) return false;
  if (name === ".env" || name.startsWith(".env.") || name.startsWith("secrets.")) return true;
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return SSH_KEY_NAME.test(name) || SECRET_NAMES.has(name);
}

function isSystemOrHomeDot(p: string): boolean {
  const s = segmentsOf(p);
  if (p.startsWith("/")) {
    if (SYSTEM_FOLDERS.has(s[0])) return true;
    return HOME_FOLDERS.has(s[0]) && s.length >= 3 && s[2].startsWith(".");
  }
  return s[0] === "~" && s.length >= 2 && s[1].startsWith(".");
}

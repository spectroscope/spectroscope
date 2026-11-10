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

// Names and folders compared in lower case: the default macOS file system opens `.ENV` as `.env`.
// A segment here marks a folder on the way or the name itself.
const KEY_STORE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", "keychains"]);
// These two, and the names secrets.* and credentials.*, do not count for source code or prose.
const DATA_SEGMENTS = new Set(["secrets", "credentials"]);
const CODE_EXTENSIONS = new Set(
  "ts tsx js jsx mjs cjs java kt py go rs rb swift c h cpp cs php scala md".split(" "),
);
const SECRET_NAMES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", "kubeconfig"]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx"];
const SSH_KEY_NAME = /^id_(?:rsa|ed25519|ecdsa|dsa)/;
const TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

// Call B1: the folders that count as sensitive when no workspace was recorded.
const SYSTEM_FOLDERS = new Set(["etc", "var", "private", "tmp", "usr", "library", "system"]);
const HOME_FOLDERS = new Set(["users", "home"]);

/** True when the path's name or a folder on its way is secret-shaped. A `*.pub` public key never is. */
export function isSecretPath(path: string): boolean {
  const segments = segmentsOf(normal(path)).map((s) => s.toLowerCase());
  const name = segments[segments.length - 1] ?? "";
  const ext = extensionOf(name);
  if (ext === "pub") return false;
  if (segments.some((s) => KEY_STORE_SEGMENTS.has(s))) return true;
  const code = CODE_EXTENSIONS.has(ext);
  if (!code && segments.some((s) => DATA_SEGMENTS.has(s))) return true;
  return isSecretName(name, code);
}

/** The level of one path. Never `unknown`: that level belongs to scripts, not to paths. */
export function pathLevel(path: string, workspace: string | null): Level {
  if (isSecretPath(path)) return "critical";
  const p = normal(path);
  const root = workspaceRoot(workspace);
  if (root === null) return isSystemFolder(p) || isHomeDot(p) ? "sensitive" : "project";
  if (outsideWorkspace(path, workspace)) return "sensitive";
  // A home folder's dot files stay sensitive in a workspace that holds the home folder.
  return isHomeDot(p) && !isHomeDot(root) ? "sensitive" : "project";
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

// The part after the last dot, or "" for a name without a dot.
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/** A name with a glob character: secret when its literal part is a secret name, or it opens like an SSH key (`id_*`). */
const GLOB_CHAR = /[*?[\]{}]/;
function isSecretPattern(name: string, code: boolean): boolean {
  if (/^id_/.test(name)) return true;
  const literal = name.replace(/\[[^\]]*\]|\{[^}]*\}|[*?]/g, "");
  return literal !== "" && isSecretName(literal, code);
}

function isSecretName(name: string, code: boolean): boolean {
  // A pattern (`.env*`, `*.pem`, `id_*`) is secret by what it keeps literal (fix round 2 item 2).
  if (GLOB_CHAR.test(name)) return isSecretPattern(name, code);
  if (TEMPLATE_SUFFIXES.has(extensionOf(name))) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (!code && (name.startsWith("secrets.") || name.startsWith("credentials."))) return true;
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return SSH_KEY_NAME.test(name) || SECRET_NAMES.has(name);
}

function isSystemFolder(p: string): boolean {
  return p.startsWith("/") && SYSTEM_FOLDERS.has((segmentsOf(p)[0] ?? "").toLowerCase());
}

// `/Users/<n>/.x`, `/home/<n>/.x` or `~/.x`, and anything below such a dot folder.
function isHomeDot(p: string): boolean {
  const s = segmentsOf(p);
  if (p.startsWith("/")) {
    return HOME_FOLDERS.has((s[0] ?? "").toLowerCase()) && s.length >= 3 && s[2].startsWith(".");
  }
  return s[0] === "~" && s.length >= 2 && s[1].startsWith(".");
}

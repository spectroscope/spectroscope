// The exact `spectro node …` command the cockpit prints beside the fleet spawn
// form. The web spawn is deliberately readonly (the endpoint is browser-reachable,
// so it must not launch a node that can write or run code). For a full-power node
// the operator copies this command into their own terminal — same fields, plus
// the live hub port, plus the permission they actually want.

export type NodePermission = "readonly" | "auto" | "ask";

export interface NodeSpawnFields {
  prompt: string;
  context: string;
  role: string;
  id: string;
  linger: boolean;
}

/** POSIX single-quote a value, so a prompt with spaces, dashes or quotes stays
 *  one shell argument (a leading dash can never be re-read as a flag). */
function q(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the copy-paste `spectro node …` command. readonly omits --permissions
 * (the node's own default); empty fields become explicit <placeholders> so the
 * shape stays legible before the form is filled.
 */
export function buildNodeCommand(
  f: NodeSpawnFields,
  hubPort: number | null,
  permissions: NodePermission,
): string {
  // Quote EVERY interpolated value, not just the prompt: context is prefilled
  // from bus-derived fleet data (not operator keystrokes) and is unvalidated on
  // this display path, so a hostile contextId must not become a shell breakout
  // when the operator pastes the line. The hub-port fallback avoids shell
  // metacharacters (no angle brackets) for the same reason.
  const parts = ["spectro node"];
  parts.push(`-p ${q(f.prompt.trim() || "<prompt>")}`);
  parts.push(`--hub 127.0.0.1:${hubPort ?? "HUB_PORT"}`);
  parts.push(`--context ${q(f.context.trim() || "<context>")}`);
  const role = f.role.trim();
  if (role && role !== "worker") parts.push(`--role ${q(role)}`);
  const id = f.id.trim();
  if (id) parts.push(`--id ${q(id)}`);
  if (permissions !== "readonly") parts.push(`--permissions ${permissions}`);
  if (f.linger) parts.push("--linger");
  return parts.join(" ");
}

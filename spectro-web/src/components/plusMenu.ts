// The plus menu's MCP decisions (card 224), pure. The component wires DOM
// events to these — same split as workspaceGear.ts / ComposerGear.
//
// Source of truth: GET /api/settings, the SERVED config — the same resolved
// view the settings page reads, and the same list `buildAgentOnce` hands to
// McpServerRegistry.load for this session's next build. Never a live probe:
// card 221 measured a mute server hanging a load, and this menu must never
// block on opening.
//
// The web face has no registry handle (measured on card 221), so a row here
// does not know whether a configured server ANSWERED last time — and it does
// not pretend to. It shows what the config says: the name, what turning it on
// will run, and the switch. `spectro doctor` and the REPL's /mcp are where
// reachability lives.

import type { SettingsView } from "../state/serverSettings";

/** The scopes PUT /api/settings/{scope} accepts — the only layers a switch in
 *  this app can honestly claim to have written. */
export type McpScope = "user" | "project" | "local";

const WRITABLE: readonly McpScope[] = ["user", "project", "local"];

/** One configured server, as the submenu draws it. */
export interface McpRow {
  name: string;
  /** What turning it on will DO: the command line for a stdio server
   *  ("npx -y tavily-mcp" — the command with its args, because "npx" alone
   *  says nothing), the URL for HTTP/SSE. A person must be able to read what
   *  a server executes before enabling it. */
  target: string;
  /** Only an explicit false is off — an absent flag is on, so every config
   *  written before card 224 keeps its servers running. Mirrors
   *  McpServerConfig.enabledOrDefault, which is what the next build obeys. */
  enabled: boolean;
}

export interface McpModel {
  rows: McpRow[];
  /** The writable scope whose layer owns the whole mcpServers block, or null
   *  when the owner is a layer this app cannot write (env, launch-dir, flags)
   *  — or when nothing configured one. mcpServers is whole-block merge, so a
   *  flag flipped anywhere else would change nothing while the switch redraws
   *  green, which is the card-222 lie one menu over. */
  scope: McpScope | null;
}

/** One effective mcpServers entry as the server serializes it — the resolved
 *  McpServerConfig record, nulls included. */
interface EffectiveServer {
  name?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  enabled?: unknown;
}

/** The row line for one entry — command + args for stdio, the URL for
 *  HTTP/SSE. Exported because the settings page's own rows print the same
 *  truth (card 224 criterion: a person sees what a server executes before
 *  turning it on), and two renderings of "what runs" would drift.
 *  @param entry a server entry, effective or raw — both carry these keys
 *  @returns the executable line, or "" for a malformed entry */
export function mcpTarget(entry: EffectiveServer): string {
  if (typeof entry.command === "string" && entry.command !== "") {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    return [entry.command, ...args].join(" ");
  }
  return typeof entry.url === "string" ? entry.url : "";
}

/**
 * What the MCP submenu draws, off the served view.
 *
 * @param view the settings view, or null while the fetch is in flight
 * @returns null while loading; else the rows in config order plus the scope a
 *          toggle would write to
 */
export function mcpModel(view: SettingsView | null): McpModel | null {
  if (view === null) return null;
  const servers = Array.isArray(view.effective["mcpServers"])
    ? (view.effective["mcpServers"] as EffectiveServer[])
    : [];
  const rows: McpRow[] = servers
    .filter((entry) => typeof entry.name === "string" && entry.name !== "")
    .map((entry) => ({
      name: entry.name as string,
      target: mcpTarget(entry),
      enabled: entry.enabled !== false,
    }));
  const winner = view.origins["mcpServers"]?.winner;
  const scope = (WRITABLE as readonly string[]).includes(winner ?? "") ? (winner as McpScope) : null;
  return { rows, scope };
}

/**
 * The next raw block a toggle should PUT — the owning layer's own mcpServers
 * object with ONE entry's flag flipped, everything else byte-identical. The
 * write replaces the whole block (whole-block merge), so the block travels
 * complete or not at all.
 *
 * <p>The flag is written explicitly in both directions (true / false) rather
 * than removed when re-enabling: the file then says what the switch did,
 * instead of meaning it by omission.</p>
 *
 * @param view the settings view the menu was drawn from
 * @param name the server to flip
 * @returns the next block for putSettings, or null when there is nothing this
 *          app may honestly write — no writable owning scope, or a name the
 *          owning block does not carry
 */
export function toggledMcpBlock(view: SettingsView, name: string): Record<string, unknown> | null {
  const model = mcpModel(view);
  if (model === null || model.scope === null) return null;
  const raw = view.layers[model.scope]?.["mcpServers"];
  if (typeof raw !== "object" || raw === null) return null;
  const block = raw as Record<string, unknown>;
  const entry = block[name];
  if (typeof entry !== "object" || entry === null) return null;
  const wasOn = (entry as Record<string, unknown>)["enabled"] !== false;
  return { ...block, [name]: { ...(entry as Record<string, unknown>), enabled: !wasOn } };
}

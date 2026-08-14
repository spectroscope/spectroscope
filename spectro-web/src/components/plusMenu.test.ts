// The plus menu's MCP half, decided in node (card 224).
//
// The rows come from the SERVED CONFIG — GET /api/settings, the same resolved
// view the settings page reads — and never from a live probe: card 221 measured
// a mute server hanging a load, and a menu that dials servers to draw itself
// would hang the composer. What a row shows is what turning it on will RUN
// (the command line for stdio, the URL for HTTP/SSE), because a person must see
// what a server executes before enabling it.
//
// The toggle writes into the layer that OWNS the block. mcpServers is
// whole-block merge (the winning layer replaces everything below it), so a flag
// flipped in a losing layer would change nothing while the switch redraws — the
// exact lie card 222 is about. A block owned by a layer this app cannot write
// (env, launch-dir, flags) gets no writable scope, and the component draws the
// switch disabled instead of pretending.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SettingsView } from "../state/serverSettings";
import { SETTING_REACH, reachOf } from "./settingsReach";
import { mcpModel, toggledMcpBlock } from "./plusMenu";

/** A settings view as the server answers it: effective.mcpServers is the
 *  resolved LIST (each entry already carrying its name), the layers hold the
 *  raw Claude-Desktop-shaped block keyed by name. */
function view(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    effective: {
      mcpServers: [
        { name: "notes", command: "java", args: ["-jar", "notes.jar"], enabled: null },
        { name: "tavily", command: "npx", args: ["-y", "tavily-mcp"], enabled: false },
        { name: "remote", url: "http://localhost:8931/sse", type: "sse", enabled: true },
      ],
    },
    origins: { mcpServers: { winner: "user", shadowed: [] } },
    layers: {
      user: {
        mcpServers: {
          notes: { command: "java", args: ["-jar", "notes.jar"] },
          tavily: { command: "npx", args: ["-y", "tavily-mcp"], enabled: false },
          remote: { url: "http://localhost:8931/sse", type: "sse", enabled: true },
        },
      },
    },
    files: {},
    workspace: null,
    ...overrides,
  };
}

describe("what the MCP submenu draws", () => {
  it("is still loading while the settings fetch is", () => {
    expect(mcpModel(null)).toBeNull();
  });

  it("shows every configured server with the line it would execute", () => {
    const model = mcpModel(view())!;
    expect(model.rows.map((r) => r.name)).toEqual(["notes", "tavily", "remote"]);
    // The reference shows "npx -y tavily-mcp" — the command WITH its args,
    // because "npx" alone says nothing about what runs.
    expect(model.rows[1]!.target).toBe("npx -y tavily-mcp");
    expect(model.rows[0]!.target).toBe("java -jar notes.jar");
    // An HTTP/SSE server executes nothing here; what it does is dial out.
    expect(model.rows[2]!.target).toBe("http://localhost:8931/sse");
  });

  it("reads an absent flag as on — every config written before the flag", () => {
    const model = mcpModel(view())!;
    expect(model.rows.map((r) => r.enabled)).toEqual([true, false, true]);
  });

  it("answers an empty config as empty rows, not a failure", () => {
    const model = mcpModel(view({ effective: { mcpServers: [] } }))!;
    expect(model.rows).toEqual([]);
  });

  it("names the writable scope that owns the block", () => {
    expect(mcpModel(view())!.scope).toBe("user");
    const project = view({ origins: { mcpServers: { winner: "project", shadowed: ["user"] } } });
    expect(mcpModel(project)!.scope).toBe("project");
  });

  it("refuses a scope this app cannot write, instead of pretending", () => {
    // launch-dir is a real layer and not a PUT target — a switch that "saved"
    // there would redraw green over a file nothing changed.
    const foreign = view({ origins: { mcpServers: { winner: "launch-dir", shadowed: [] } } });
    expect(mcpModel(foreign)!.scope).toBeNull();
  });
});

describe("what the toggle writes", () => {
  it("flips one entry inside the owning layer's raw block, explicitly", () => {
    const next = toggledMcpBlock(view(), "tavily")!;
    // Off becomes an explicit true, on becomes an explicit false — the file
    // says what the switch did, rather than meaning it by omission.
    expect((next["tavily"] as Record<string, unknown>)["enabled"]).toBe(true);
    // The rest of the block travels untouched: whole-block merge means the
    // write REPLACES the layer's block, so losing an entry here deletes it.
    expect((next["notes"] as Record<string, unknown>)["args"]).toEqual(["-jar", "notes.jar"]);
    expect(Object.keys(next)).toEqual(["notes", "tavily", "remote"]);
  });

  it("switches an on-by-absence entry off without inventing other keys", () => {
    const next = toggledMcpBlock(view(), "notes")!;
    expect(next["notes"]).toEqual({ command: "java", args: ["-jar", "notes.jar"], enabled: false });
  });

  it("writes nothing for a name the owning block does not carry", () => {
    expect(toggledMcpBlock(view(), "ghost")).toBeNull();
  });

  it("writes nothing when the owning layer is not writable", () => {
    const foreign = view({ origins: { mcpServers: { winner: "env", shadowed: [] } } });
    expect(toggledMcpBlock(foreign, "notes")).toBeNull();
  });
});

describe("the sentence under the menu's switches", () => {
  // The generic reach walker (settingsReach.test.tsx) proves every SAVED field
  // sits under a block that names it — but the plus menu's skill rows save via
  // POST /api/skills/*/disabled, which no putSettings-shaped regex can see. So
  // the two facts that make the menu honest are pinned here by hand: both
  // kinds land at the NEXT AGENT BUILD (SkillLibrary.load and
  // McpServerRegistry.load both run inside buildAgentOnce), and the component
  // derives its sentences from that table rather than hand-writing them.
  const source = readFileSync(fileURLToPath(new URL("./PlusMenuSettings.tsx", import.meta.url)), "utf8");

  it("classifies both kinds as next-session, like the settings page", () => {
    expect(SETTING_REACH.skills).toBe("next-session");
    expect(SETTING_REACH.mcpServers).toBe("next-session");
    expect(reachOf(["skills", "mcpServers"])).toBe("next-session");
  });

  it("derives one sentence per submenu, through ReachBlock", () => {
    // The literal fields, so a refactor cannot quietly put the skill switches
    // under the MCP sentence (or either under a live one).
    expect(source).toContain('<ReachBlock lang={lang} fields={["skills"]}>');
    expect(source).toContain('<ReachBlock lang={lang} fields={["mcpServers"]}>');
    // And never the raw sentence keys — through the block or not at all, the
    // same rule the settings page obeys.
    expect(source).not.toContain('"set.reachLive"');
    expect(source).not.toContain('"set.reachNextSession"');
  });

  it("keeps the settings page reachable from both submenus", () => {
    // Criterion 3: Manage/Browse open the page — nothing replaces it.
    for (const section of ['pick("skills")', 'pick("skills-catalogue")', 'pick("mcp")']) {
      expect(source).toContain(section);
    }
  });
});

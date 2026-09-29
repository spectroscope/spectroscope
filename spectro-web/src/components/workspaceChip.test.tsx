// Card 462 (owner, 2026-09-29): "Ich will auch ... einen Ordner oben im Menü
// haben, in welchem Ordner wir uns befinden mit Interaktionsmöglichkeiten",
// after Claude Code's folder chip (its menu: Im Finder anzeigen, Pfad kopieren,
// Ordner ändern, Im Terminal öffnen). The header names the working folder of
// the live session, and its menu has those four actions.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceInfo } from "../state/reducer";
import {
  WorkspaceChip,
  chipActions,
  chipLabel,
  failureText,
  menuShift,
  postWorkspaceAction,
  WORKSPACE_CHIP_ACTIONS,
} from "./WorkspaceChip";
import { blockOf, read, stripComments } from "../testkit/source";

const RESOLVED: WorkspaceInfo = {
  sessionId: "a1b2c3",
  path: "/Users/someone/projects/spectroscope",
  configured: true,
  resolved: true,
  mode: "set",
};
const PROSPECTIVE: WorkspaceInfo = {
  path: "/Users/someone/projects/spectroscope",
  configured: true,
  resolved: false,
  mode: "set",
};
const RANDOM_BEFORE_A_RUN: WorkspaceInfo = { configured: false, resolved: false, mode: "random" };

const ON_A_MAC = { canPick: true, mac: true };
const enabled = (ws: WorkspaceInfo, opts = ON_A_MAC) =>
  chipActions(ws, opts)
    .filter((a) => a.enabled)
    .map((a) => a.id);

describe("the chip names the folder", () => {
  it("by its own name, the whole path left for the tooltip", () => {
    expect(chipLabel("en", RESOLVED)).toBe("spectroscope");
  });

  it("says so when there is no folder yet", () => {
    expect(chipLabel("en", RANDOM_BEFORE_A_RUN)).toBe("no folder");
    expect(chipLabel("de", RANDOM_BEFORE_A_RUN)).toBe("kein Ordner");
  });
});

describe("the four actions", () => {
  it("come in Claude Code's order", () => {
    expect([...WORKSPACE_CHIP_ACTIONS]).toEqual(["reveal", "copy", "change", "terminal"]);
  });

  it("all work once the session exists and names its folder", () => {
    expect(enabled(RESOLVED)).toEqual(["reveal", "copy", "change", "terminal"]);
  });

  it("before the first message, Finder and Terminal wait: the server knows the folder by the session", () => {
    expect(enabled(PROSPECTIVE)).toEqual(["copy", "change"]);
  });

  it("with no path at all, only changing the folder is on offer", () => {
    expect(enabled(RANDOM_BEFORE_A_RUN)).toEqual(["change"]);
  });

  it("changes the folder only where the chooser may (card 428): before the first message, not while running", () => {
    expect(enabled(RESOLVED, { canPick: false, mac: true })).toEqual(["reveal", "copy", "terminal"]);
    const change = chipActions(RESOLVED, { canPick: false, mac: true }).find((a) => a.id === "change");
    expect(change?.reason).toBe("wchip.changeLocked");
  });

  it("offers Finder and Terminal on macOS only, where the server can open them", () => {
    expect(enabled(RESOLVED, { canPick: true, mac: false })).toEqual(["copy", "change"]);
    const reveal = chipActions(RESOLVED, { canPick: true, mac: false }).find((a) => a.id === "reveal");
    expect(reveal?.reason).toBe("wchip.macOnly");
  });

  it("draws each row with its icon and its name, the waiting ones disabled with the reason", () => {
    const html = renderToStaticMarkup(
      <WorkspaceChip workspace={PROSPECTIVE} onPickFolder={() => {}} canPick mac menuOpenForTest />,
    );
    const rows = [...html.matchAll(/<button[^>]*data-ws-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(rows.map((r) => r[1])).toEqual([...WORKSPACE_CHIP_ACTIONS]);
    for (const [whole, id, body] of rows) {
      expect(body, id).toContain("<svg");
      expect(body.replace(/<[^>]+>/g, "").trim().length, id).toBeGreaterThan(3);
      const disabled = whole.slice(0, whole.indexOf(">")).includes("disabled");
      expect(disabled, id).toBe(id === "reveal" || id === "terminal");
    }
    expect(html).toContain("Available after the first message");
  });
});

describe("Finder and Terminal ask the server, by session id and never by path", () => {
  it.each([
    ["reveal", "/api/workspace/reveal"],
    ["terminal", "/api/workspace/terminal"],
  ] as const)("%s posts the session id to %s", async (kind, url) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (u: string, init: RequestInit) => {
      seen.push({ url: u, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await postWorkspaceAction(kind, "a1b2c3", fake)).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(url);
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ sessionId: "a1b2c3" });
    expect(new Headers(seen[0].init.headers).get("Content-Type")).toBe("application/json");
  });

  it("says in words why it did not work", () => {
    expect(failureText("en", 0)).toBe("The server is not reachable");
    expect(failureText("en", 501)).toBe("Only on macOS");
    expect(failureText("en", 404)).toBe("The session has no folder on disk");
    expect(failureText("en", 500)).toBe("That did not work (500)");
  });

  it("answers the status the server gave, and 0 when it cannot be reached", async () => {
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await postWorkspaceAction("reveal", "a1b2c3", notFound)).toBe(404);
    expect(await postWorkspaceAction("reveal", "a1b2c3", down)).toBe(0);
  });
});

describe("the menu stays in the window", () => {
  it("shifts left by what would run past the right edge, and no further than the left margin", () => {
    // Measured 2026-09-29 at 390 px: the chip starts at 133 px, the menu is
    // 260 px wide, and it ran 3.7 px past the window.
    expect(menuShift(133, 260, 390)).toBe(390 - 8 - 393);
    expect(menuShift(10, 260, 1440)).toBe(0);
    expect(menuShift(300, 500, 390)).toBe(8 - 300);
  });
});

describe("the keyboard walks the menu", () => {
  it("focuses the first row on open and moves with the arrows, as the header menu does", () => {
    const source = stripComments(read("./WorkspaceChip.tsx", import.meta.url));
    expect(source).toContain("nextMenuIndex(");
    expect(source).toContain('querySelector<HTMLButtonElement>("[data-ws-action]:not(:disabled)")?.focus()');
  });
});

describe("where it lives", () => {
  const header = stripComments(read("./AppHeader.tsx", import.meta.url));
  const css = read("../styles/header.css", import.meta.url);

  it("is mounted once in the header, after the title and before the learn and light switch", () => {
    expect(header.split("<WorkspaceChip").length - 1).toBe(1);
    expect(header.indexOf("<WorkspaceChip")).toBeGreaterThan(header.indexOf('className="header-title"'));
    expect(header.indexOf("<WorkspaceChip")).toBeLessThan(header.indexOf("<ModeSwitch"));
  });

  it("keeps to its icon in a narrow window, where the name would be cut to a letter", () => {
    expect(css).toMatch(/@media \(max-width: 520px\) \{\s*\.ws-chip-name \{\s*display: none;/);
  });

  it("opens its menu downward from its left edge and keeps it in the window", () => {
    const block = blockOf(css, ".wsg-pop.ws-chip-pop");
    expect(block).toMatch(/top:\s*calc\(100% \+ 6px\)/);
    expect(block).toMatch(/bottom:\s*auto/);
    expect(block).toMatch(/left:\s*0/);
    expect(block).toMatch(/max-width:\s*calc\(100vw - /);
  });
});

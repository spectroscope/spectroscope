// Card 442 (owner, 2026-09-29): "diese ganzen Symbole, verstecke die hinter
// den vier Punkten". The header keeps three icon buttons, the sidebar toggle,
// the side panel toggle and the ⋮ menu; the language, the settings, the
// keyboard shortcuts, spectro doctor and Stop left it. The icons it may carry come from one table in AppHeader, so
// an icon added outside the table turns this red.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader, HEADER_ICONS } from "./AppHeader";
import { read } from "../testkit/source";

function header(over: Partial<Parameters<typeof AppHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    <AppHeader
      sidebarOpen={false}
      onToggleSidebar={() => {}}
      replayId={null}
      title="a session"
      imageCount={0}
      showPanelToggle
      panelOpen={false}
      onTogglePanel={() => {}}
      doctorOpen={false}
      onToggleDoctor={() => {}}
      onOpenKeymap={() => {}}
      {...over}
    />,
  );
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("the header carries the icons of one table and no others", () => {
  it("names them in one table: the sidebar toggle, the side panel toggle and the menu", () => {
    // Owner, 2026-09-29, second message: "der Button, dass Seitenpanel aus-
    // und einzuklappen. Der sollte draußen sein ... Links daneben."
    expect([...HEADER_ICONS]).toEqual(["sidebar", "panel", "menu"]);
  });

  it("draws exactly the icons of the table on the chat tab, and no panel toggle off it", () => {
    const chat = header({ showPanelToggle: true });
    expect([...chat.matchAll(/data-header-icon="([^"]+)"/g)].map((m) => m[1])).toEqual([...HEADER_ICONS]);
    expect(count(chat, 'class="icon-button')).toBe(HEADER_ICONS.length);
    // The dock exists on the chat tab only, and so does its toggle.
    const other = header({ showPanelToggle: false });
    expect([...other.matchAll(/data-header-icon="([^"]+)"/g)].map((m) => m[1])).toEqual(["sidebar", "menu"]);
    expect(count(other, 'class="icon-button')).toBe(2);
  });

  it("puts the side panel toggle right beside the menu, on its left", () => {
    const html = header({ showPanelToggle: true });
    const panel = html.indexOf('data-header-icon="panel"');
    const menu = html.indexOf('data-header-icon="menu"');
    expect(panel).toBeGreaterThan(html.indexOf('role="radiogroup"'));
    expect(panel).toBeLessThan(menu);
    // Between the two attributes stands exactly one opening tag: the menu
    // button's own, so no control sits between the toggle and the menu.
    expect(html.slice(panel, menu).split("<button").length - 1).toBe(1);
  });

  it("has no language button, no settings gear, no shortcut or doctor icon any more", () => {
    const html = header();
    expect(html).not.toContain("lang-toggle");
    expect(html).not.toContain('aria-label="Settings"');
    expect(html).not.toContain("keyboard shortcuts");
    expect(html).not.toContain("hdr-panel-icon");
  });

  it("has no Stop button: the composer's own stop seat stops a run", () => {
    // Owner, 2026-09-29: "den Stop-Button oben rechts, den brauchen wir jetzt
    // auch nicht mehr, weil den haben wir jetzt inline im Chatfenster unten."
    const header = read("./AppHeader.tsx", import.meta.url);
    expect(header).not.toContain('className="stop"');
    expect(header).not.toMatch(/onAbort|running/);
    const chat = read("./Chat.tsx", import.meta.url);
    expect(chat).toContain("composer-seat composer-seat--stop");
  });

  it("keeps the learn and light switch", () => {
    expect(header()).toContain('role="radiogroup"');
  });
});

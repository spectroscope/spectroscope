// Card 445: what the row, its menu, the delete question and the pinned group
// RENDER. Read off static markup (renderToStaticMarkup, no DOM), the idiom
// sessionRowDensity.test.tsx already uses. Opening, focus and portals need a
// browser; the wave's browser stage checks those on the built app.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow } from "./Sidebar";
import { SessionGroups } from "./SessionGroups";
import { RowMenuList } from "./SessionRowMenu";
import { SessionDeleteDialogBody } from "./SessionDeleteDialog";
import { renameOpening, rowMenuItems } from "./rowMenuItems";
import { rowParts } from "../state/density";
import type { SessionMeta } from "../events";

const TITLED: SessionMeta = {
  id: "20260925-101500-ab12cd34",
  startedAt: Date.UTC(2026, 8, 25, 10, 15, 0),
  firstPrompt: "lese die CLAUDE.md und schaue dir die offenen tickets an",
  tokens: 1200,
  stopReason: "end_turn",
  title: "Subagenten und Workflows Review",
  titleSource: "suggested",
};

const UNTITLED: SessionMeta = {
  id: "20260925-091500-cd34ef56",
  startedAt: Date.UTC(2026, 8, 25, 9, 15, 0),
  firstPrompt: "hallo",
  tokens: 10,
  stopReason: "end_turn",
};

const noop = (): void => {};

function rowHtml(s: SessionMeta, extra: Partial<Parameters<typeof SessionRow>[0]> = {}): string {
  return renderToStaticMarkup(
    <SessionRow
      s={s}
      parts={rowParts("normal")}
      lang="en"
      active={false}
      state="idle"
      onSelect={noop}
      {...extra}
    />,
  );
}

/** The row button's own markup, from its opening tag to its closing one. */
function rowButton(html: string): string {
  const start = html.indexOf('<button type="button" class="session-row');
  const end = html.indexOf("</button>", start);
  return html.slice(start, end + "</button>".length);
}

describe("a stored row with a title", () => {
  it("shows the title and keeps the first prompt in the hover", () => {
    const html = rowHtml(TITLED);
    expect(html).toContain('<span class="session-name">Subagenten und Workflows Review</span>');
    const hover = rowButton(html).match(/title="([^"]*)"/)?.[1] ?? "";
    expect(hover.split("\n")[0]).toBe("Subagenten und Workflows Review");
    expect(hover).toContain("lese die CLAUDE.md und schaue dir die offenen tickets an");
  });
});

describe("the menu button", () => {
  const menu = { items: rowMenuItems({ pinned: false, hasTitle: true, deletable: true }), onPick: noop };

  it("sits at the row's right end, beside the row button and not inside it", () => {
    const html = rowHtml(TITLED, { menu });
    expect(html).toMatch(/^<div class="session-item[^"]*" data-session-id="20260925-101500-ab12cd34"/);
    expect(rowButton(html)).not.toContain("session-menu-btn");
    expect(html.indexOf("session-menu-btn")).toBeGreaterThan(html.indexOf("</button>"));
  });

  it("announces a menu and names the session it acts on", () => {
    const html = rowHtml(TITLED, { menu });
    const btn = html.slice(html.indexOf('<button type="button" class="session-menu-btn"'));
    expect(btn).toContain('aria-haspopup="menu"');
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-label="Actions for Subagenten und Workflows Review"');
  });

  it("is on every stored row the list draws with a menu, and on none without one", () => {
    expect(rowHtml(UNTITLED, { menu })).toContain("session-menu-btn");
    expect(rowHtml(UNTITLED)).not.toContain("session-menu-btn");
  });
});

describe("the open menu", () => {
  it("is a menu of items, delete drawn as danger", () => {
    const items = rowMenuItems({ pinned: false, hasTitle: false, deletable: true });
    const html = renderToStaticMarkup(<RowMenuList lang="en" items={items} focus={0} onPick={noop} />);
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(4);
    expect(html).toMatch(/class="row-menu-item row-menu-item--danger"[^>]*>Delete</);
    expect(html).toContain(">Pin<");
    expect(html).toContain(">Rename<");
    expect(html).toContain(">Suggest a title<");
  });

  it("speaks German", () => {
    const items = rowMenuItems({ pinned: true, hasTitle: true, deletable: true });
    const html = renderToStaticMarkup(<RowMenuList lang="de" items={items} focus={0} onPick={noop} />);
    expect(html).toContain(">Nicht mehr anheften<");
    expect(html).toContain(">Umbenennen<");
    expect(html).toContain(">Löschen<");
  });

  it("marks a delete it cannot do as disabled, with the reason as its hover", () => {
    const items = rowMenuItems({ pinned: false, hasTitle: true, deletable: false });
    const html = renderToStaticMarkup(<RowMenuList lang="en" items={items} focus={0} onPick={noop} />);
    expect(html).toMatch(/aria-disabled="true"[^>]*title="Stop or close this session before you delete it"/);
  });
});

describe("renaming", () => {
  it("turns the title into a field holding the current title", () => {
    const html = rowHtml(TITLED, {
      renameFrom: renameOpening(TITLED, "en").shown,
      onRename: noop,
      menu: { items: [], onPick: noop },
    });
    expect(html).toContain('<input class="session-rename"');
    expect(html).toContain('value="Subagenten und Workflows Review"');
    expect(html).toContain('aria-label="Session title"');
    expect(html).toContain('maxLength="80"');
    expect(html).not.toContain('class="session-row');
    expect(html).not.toContain("session-menu-btn");
  });

  it("starts from the first prompt when the row has no title", () => {
    expect(rowHtml(UNTITLED, { renameFrom: renameOpening(UNTITLED, "en").shown, onRename: noop })).toContain(
      'value="hallo"',
    );
  });

  it("holds the text it opened with when a title has landed on the row since", () => {
    // The list opened the field on the first prompt; the row now carries a suggestion.
    const html = rowHtml(TITLED, { renameFrom: "hallo", onRename: noop });
    expect(html).toContain('value="hallo"');
    expect(html).not.toContain('value="Subagenten und Workflows Review"');
  });
});

describe("the delete question", () => {
  it("names the session and asks once", () => {
    const html = renderToStaticMarkup(
      <SessionDeleteDialogBody
        lang="en"
        title="Subagenten und Workflows Review"
        busy={false}
        failed={false}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Delete this session?");
    expect(html).toContain("Subagenten und Workflows Review");
    expect(html).toContain(">Cancel<");
    expect(html).toMatch(/class="ghost session-delete-confirm"[^>]*>Delete</);
  });

  it("speaks German and says when the delete did not go through", () => {
    const html = renderToStaticMarkup(
      <SessionDeleteDialogBody
        lang="de"
        title="hallo"
        busy={false}
        failed={true}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
    expect(html).toContain("Diese Session löschen?");
    expect(html).toContain(">Abbrechen<");
    expect(html).toContain("konnte nicht gelöscht werden");
  });
});

describe("the pinned group", () => {
  const live = (
    <button type="button" className="session-row live-row">
      live
    </button>
  );
  const draw = (s: SessionMeta) => (
    <span key={s.id} className="probe">
      {s.id}
    </span>
  );

  it("heads the list with its pinned rows, the rest under Recent with the live row first", () => {
    const html = renderToStaticMarkup(
      <SessionGroups lang="en" groups={{ pinned: [TITLED], rest: [UNTITLED] }} live={live} row={draw} />,
    );
    const at = (needle: string) => html.indexOf(needle);
    expect(at(">Pinned<")).toBeGreaterThan(-1);
    expect(at(">Pinned<")).toBeLessThan(at(TITLED.id));
    expect(at(TITLED.id)).toBeLessThan(at(">Recent<"));
    expect(at(">Recent<")).toBeLessThan(at("live-row"));
    expect(at("live-row")).toBeLessThan(at(UNTITLED.id));
  });

  it("names the group in German", () => {
    const html = renderToStaticMarkup(
      <SessionGroups lang="de" groups={{ pinned: [TITLED], rest: [] }} live={live} row={draw} />,
    );
    expect(html).toContain(">Angeheftet<");
    expect(html).toContain(">Zuletzt<");
  });

  it("draws no headings while nothing is pinned", () => {
    const html = renderToStaticMarkup(
      <SessionGroups lang="en" groups={{ pinned: [], rest: [UNTITLED] }} live={live} row={draw} />,
    );
    expect(html).not.toContain("Pinned");
    expect(html).not.toContain("Recent");
    expect(html.indexOf("live-row")).toBeLessThan(html.indexOf(UNTITLED.id));
  });
});

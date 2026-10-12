// Card 546, fix round 1: what a press on a code graph row of the ⋮ menu and
// the folder chip DOES. The first round rendered static markup and called
// pressCodeGraphRow directly, so rewiring a row's onClick to "build" stayed
// green (reviewer bites a and b). This suite has no DOM, so nothing is
// clicked: the component runs inside a probe, the probe keeps the element tree
// it returned, and the row button's own onClick is called (the StoreRow test
// does the same with a hook-free component).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodeGraphRow, CodeGraphStatus } from "./codeGraphModel";
import {
  codeGraphState,
  followCodeGraphSession,
  resetCodeGraphForTest,
  setCodeGraphStatus,
} from "./codeGraphStore";
import { pressCodeGraphRow } from "./CodeGraphHeaderStatus";
import { browserOpenSeq, takeCodeGraphOpen } from "../state/browserOpen";
import { __resetForTests } from "../state/layout";
import { CODE_GRAPH_ROW_IDS, HeaderMenu } from "../panels/headerPanelControls";
import { CODE_GRAPH_EXTRA, WorkspaceChip } from "../components/WorkspaceChip";
import { t } from "../i18n/i18n";
import { setLang } from "../state/lang";
import type { WorkspaceInfo } from "../state/reducer";

const NO_GRAPH: CodeGraphStatus = {
  installed: true,
  binary: "/opt/tools/graphify",
  searched: [],
  install: "uv tool install graphifyy",
  folder: "/work/project",
  graph: { exists: false, modifiedAt: null },
  job: null,
  backends: [],
};
const WITH_GRAPH: CodeGraphStatus = {
  ...NO_GRAPH,
  graph: { exists: true, modifiedAt: "2026-10-12T09:00:00Z" },
};

const WS: WorkspaceInfo = {
  sessionId: "s-1",
  path: "/work/project",
  configured: true,
  resolved: true,
  mode: "set",
};

const ROWS: CodeGraphRow[] = ["build", "show", "update"];
const noop = (): void => {};

const menuElement = (): ReactElement => (
  <HeaderMenu
    showDock
    workOffered={false}
    imageCount={0}
    doctorOpen={false}
    onToggleDoctor={noop}
    onOpenKeymap={noop}
    menuOpenForTest
  />
);
const chipElement = (): ReactElement => (
  <WorkspaceChip workspace={WS} onPickFolder={noop} canPick mac menuOpenForTest />
);

/** Runs the component inside a probe and returns the element tree it rendered. */
function captured(element: ReactElement): ReactElement {
  const component = element.type as (props: unknown) => ReactElement;
  let tree: ReactElement | null = null;
  function Probe(): ReactElement {
    tree = component(element.props);
    return tree;
  }
  renderToStaticMarkup(<Probe />);
  if (tree === null) throw new Error("the component rendered nothing");
  return tree;
}

/** The first element in the tree whose props carry attr === value. */
function find(node: ReactNode, attr: string, value: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, attr, value);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props[attr] === value) return node as ReactElement<Record<string, unknown>>;
  return find(props.children as ReactNode, attr, value);
}

/** Presses one row of the rendered menu or chip through its own onClick. */
function press(element: ReactElement, attr: string, id: string): void {
  const button = find(captured(element), attr, id);
  expect(button, `no row ${attr}="${id}"`).not.toBeNull();
  (button?.props.onClick as () => void)();
}

beforeEach(() => __resetForTests());
afterEach(() => {
  resetCodeGraphForTest();
  setLang("en");
});

describe("a press on a row of the ⋮ menu", () => {
  it("Show asks the browser panel for the graph and opens no sheet", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    press(menuElement(), "data-menu-row", "codegraphShow");
    expect(codeGraphState().sheet).toBeNull();
    expect(takeCodeGraphOpen("s-1")).toBe(true);
  });

  it("Update opens the sheet on update and asks for no graph", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    press(menuElement(), "data-menu-row", "codegraphUpdate");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("update");
    expect(takeCodeGraphOpen("s-1")).toBe(false);
  });

  it("Build opens the sheet on a full build", () => {
    setCodeGraphStatus("s-1", NO_GRAPH);
    press(menuElement(), "data-menu-row", "codegraph");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("full");
  });
});

describe("a press on a row of the folder chip", () => {
  it("Show asks the browser panel for the graph and opens no sheet", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    press(chipElement(), "data-ws-extra", "codegraphShow");
    expect(codeGraphState().sheet).toBeNull();
    expect(takeCodeGraphOpen("s-1")).toBe(true);
  });

  it("Update opens the sheet on update and asks for no graph", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    press(chipElement(), "data-ws-extra", "codegraphUpdate");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("update");
    expect(takeCodeGraphOpen("s-1")).toBe(false);
  });

  it("Build opens the sheet on a full build", () => {
    setCodeGraphStatus("s-1", NO_GRAPH);
    press(chipElement(), "data-ws-extra", "codegraph");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("full");
  });
});

describe("Show without a session", () => {
  it("opens nothing: no sheet and no ask to the browser panel", () => {
    const before = browserOpenSeq();
    pressCodeGraphRow("show", null);
    expect(codeGraphState().sheet).toBeNull();
    expect(browserOpenSeq()).toBe(before);
  });
});

describe("a session switch", () => {
  it("drops the previous session's status at once, so Show cannot open the old graph", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    followCodeGraphSession("s-2");
    expect(codeGraphState().sessionId).toBe("s-2");
    expect(codeGraphState().status).toBeNull();
    const html = renderToStaticMarkup(menuElement());
    expect(html).toContain('data-menu-row="codegraph"');
    expect(html).not.toContain('data-menu-row="codegraphShow"');
  });

  it("keeps the status when the session stays the same (a refresh)", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    followCodeGraphSession("s-1");
    expect(codeGraphState().status).toBe(WITH_GRAPH);
  });
});

describe("the strings of every row, both languages", () => {
  it("every row id of the ⋮ menu and the chip has its own German and English name", () => {
    expect(Object.keys(CODE_GRAPH_ROW_IDS).sort()).toEqual([...ROWS].sort());
    expect(Object.keys(CODE_GRAPH_EXTRA).sort()).toEqual([...ROWS].sort());
    for (const row of ROWS) {
      for (const key of [`hdr.menu.${CODE_GRAPH_ROW_IDS[row]}`, `wchip.${CODE_GRAPH_EXTRA[row]}`]) {
        const de = t("de", key);
        const en = t("en", key);
        expect(de, key).not.toBe(key);
        expect(en, key).not.toBe(key);
        expect(de, key).not.toBe(en);
      }
    }
  });

  it("the German menu and chip show the German names on the rows", () => {
    setLang("de");
    setCodeGraphStatus("s-1", WITH_GRAPH);
    for (const html of [renderToStaticMarkup(menuElement()), renderToStaticMarkup(chipElement())]) {
      expect(html).toContain(">Code-Graph anzeigen<");
      expect(html).toContain(">Code-Graph aktualisieren<");
      expect(html).not.toContain("Show code graph");
    }
    setCodeGraphStatus("s-1", NO_GRAPH);
    for (const html of [renderToStaticMarkup(menuElement()), renderToStaticMarkup(chipElement())]) {
      expect(html).toContain(">Code-Graph bauen<");
    }
  });
});

describe("the Update glyph", () => {
  it("is the same refresh glyph in the ⋮ menu and on the folder chip", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    const icon = (html: string, attr: string, id: string): string => {
      const row = new RegExp(`<button[^>]*${attr}="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(html)?.[1] ?? "";
      return /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(row)?.[1] ?? "";
    };
    const inMenu = icon(renderToStaticMarkup(menuElement()), "data-menu-row", "codegraphUpdate");
    const onChip = icon(renderToStaticMarkup(chipElement()), "data-ws-extra", "codegraphUpdate");
    expect(inMenu).toContain("<path");
    expect(onChip).toBe(inMenu);
    const showOnChip = icon(renderToStaticMarkup(chipElement()), "data-ws-extra", "codegraphShow");
    expect(showOnChip).not.toBe(inMenu);
  });
});

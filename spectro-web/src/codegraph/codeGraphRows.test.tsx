// Card 546 (owner, 2026-10-12): "wenn ein graphify ordner daligt dann ist
// "build code graph" zu show code graph umgeändert?" When graphify-out/graph.html
// exists for the session folder, the ⋮ menu and the folder chip offer "Show code
// graph" (the chip's own ticketed open path) and "Update code graph" (the sheet
// in update mode). Without a graph the single row stays "Build code graph" and
// opens the sheet in full build mode. The rows read the status the host already
// polls, so a finished build turns Build into Show without a reload.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { codeGraphRows, type CodeGraphStatus } from "./codeGraphModel";
import {
  closeCodeGraphSheet,
  codeGraphState,
  openCodeGraphSheet,
  resetCodeGraphForTest,
  setCodeGraphStatus,
} from "./codeGraphStore";
import { pressCodeGraphRow } from "./CodeGraphHeaderStatus";
import { CodeGraphSheet } from "./CodeGraphSheet";
import { takeCodeGraphOpen } from "../state/browserOpen";
import { __resetForTests } from "../state/layout";
import { HeaderMenu } from "../panels/headerPanelControls";
import { WorkspaceChip } from "../components/WorkspaceChip";
import { t } from "../i18n/i18n";
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
const NOT_INSTALLED: CodeGraphStatus = { ...WITH_GRAPH, installed: false, binary: null };

const WS: WorkspaceInfo = {
  sessionId: "s-1",
  path: "/work/project",
  configured: true,
  resolved: true,
  mode: "set",
};

const noop = (): void => {};
const menu = (): string =>
  renderToStaticMarkup(
    <HeaderMenu
      showDock
      workOffered={false}
      imageCount={0}
      doctorOpen={false}
      onToggleDoctor={noop}
      onOpenKeymap={noop}
      menuOpenForTest
    />,
  );
const chip = (): string =>
  renderToStaticMarkup(<WorkspaceChip workspace={WS} onPickFolder={noop} canPick mac menuOpenForTest />);

/** The whole button of one menu row, by its data attribute. */
const row = (html: string, attr: string, id: string): string =>
  new RegExp(`<button[^>]*${attr}="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(html)?.[0] ?? "";
const ids = (html: string, attr: string): string[] =>
  [...html.matchAll(new RegExp(`${attr}="(codegraph[^"]*)"`, "g"))].map((m) => m[1]);

beforeEach(() => __resetForTests());
afterEach(() => resetCodeGraphForTest());

describe("the rows per state", () => {
  it("is Build alone while nothing is known or no graph exists", () => {
    expect(codeGraphRows(null)).toEqual(["build"]);
    expect(codeGraphRows({ ...NO_GRAPH, graph: null })).toEqual(["build"]);
    expect(codeGraphRows(NO_GRAPH)).toEqual(["build"]);
  });

  it("is Show then Update when graph.html exists", () => {
    expect(codeGraphRows(WITH_GRAPH)).toEqual(["show", "update"]);
  });

  it("the ⋮ menu reads Show code graph and Update code graph over a graph", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    const html = menu();
    expect(ids(html, "data-menu-row")).toEqual(["codegraphShow", "codegraphUpdate"]);
    expect(row(html, "data-menu-row", "codegraphShow")).toContain(">Show code graph<");
    expect(row(html, "data-menu-row", "codegraphUpdate")).toContain(">Update code graph<");
    expect(html).not.toContain(">Build code graph<");
  });

  it("the ⋮ menu reads Build code graph alone without a graph", () => {
    setCodeGraphStatus("s-1", NO_GRAPH);
    const html = menu();
    expect(ids(html, "data-menu-row")).toEqual(["codegraph"]);
    expect(row(html, "data-menu-row", "codegraph")).toContain(">Build code graph<");
    expect(html).not.toContain("Show code graph");
  });

  it("the folder chip reads the same two rows over a graph and Build alone without", () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    let html = chip();
    expect(ids(html, "data-ws-extra")).toEqual(["codegraphShow", "codegraphUpdate"]);
    expect(row(html, "data-ws-extra", "codegraphShow")).toContain(">Show code graph<");
    expect(row(html, "data-ws-extra", "codegraphUpdate")).toContain(">Update code graph<");
    setCodeGraphStatus("s-1", NO_GRAPH);
    html = chip();
    expect(ids(html, "data-ws-extra")).toEqual(["codegraph"]);
    expect(row(html, "data-ws-extra", "codegraph")).toContain(">Build code graph<");
  });

  it("follows a build that ends: the same store turns Build into Show without a reload", () => {
    setCodeGraphStatus("s-1", {
      ...NO_GRAPH,
      job: {
        folder: "/work/project",
        sessionId: "s-1",
        mode: "full",
        state: "running",
        startedAt: "2026-10-12T09:00:00Z",
        endedAt: null,
        exitCode: null,
        lastLine: null,
        tail: [],
      },
    });
    expect(ids(menu(), "data-menu-row")).toEqual(["codegraph"]);
    setCodeGraphStatus("s-1", WITH_GRAPH);
    expect(ids(menu(), "data-menu-row")).toEqual(["codegraphShow", "codegraphUpdate"]);
  });
});

describe("what each row does", () => {
  it("Show asks the browser panel for the graph through the chip's ticketed path and opens no sheet", () => {
    pressCodeGraphRow("show", "s-1");
    expect(codeGraphState().sheet).toBeNull();
    expect(takeCodeGraphOpen("s-1")).toBe(true);
  });

  it("Update opens the sheet in update mode, and the sheet starts on update", () => {
    pressCodeGraphRow("update", "s-1");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("update");
    expect(takeCodeGraphOpen("s-1")).toBe(false);
    // Even before the status lands (null), the sheet honours the asked mode.
    const html = renderToStaticMarkup(
      <CodeGraphSheet status={null} sessionId="s-1" view="build" mode="update" onClose={noop} />,
    );
    const update = [...html.matchAll(/<input[^>]*>/g)]
      .map((m) => m[0])
      .find((tag) => tag.includes('value="update"'));
    expect(update).toContain("checked");
  });

  it("Build opens the sheet in full build mode, even over a graph", () => {
    pressCodeGraphRow("build", "s-1");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBe("full");
    const html = renderToStaticMarkup(
      <CodeGraphSheet status={WITH_GRAPH} sessionId="s-1" view="build" mode="full" onClose={noop} />,
    );
    const full = [...html.matchAll(/<input[^>]*>/g)]
      .map((m) => m[0])
      .find((tag) => tag.includes('value="full"'));
    expect(full).toContain("checked");
  });

  it("a row's mode holds for one opening: the next opening without a mode follows the status", () => {
    pressCodeGraphRow("update", "s-1");
    closeCodeGraphSheet();
    expect(codeGraphState().sheet).toBeNull();
    // The failure lines' Build button opens the sheet without a mode.
    openCodeGraphSheet("build");
    expect(codeGraphState().sheet).toBe("build");
    expect(codeGraphState().sheetMode).toBeNull();
  });

  it("Update over a graph says Update code graph as the sheet's title", () => {
    const html = renderToStaticMarkup(
      <CodeGraphSheet status={WITH_GRAPH} sessionId="s-1" view="build" mode="update" onClose={noop} />,
    );
    expect(html).toContain('aria-label="Update code graph"');
  });
});

describe("graphify missing from the PATH", () => {
  it("Show carries no install note; Update carries it, in the menu and on the folder chip", () => {
    setCodeGraphStatus("s-1", NOT_INSTALLED);
    for (const [html, attr] of [
      [menu(), "data-menu-row"],
      [chip(), "data-ws-extra"],
    ] as const) {
      expect(row(html, attr, "codegraphShow")).toContain(">Show code graph<");
      expect(row(html, attr, "codegraphShow")).not.toContain("uv tool install graphifyy");
      expect(row(html, attr, "codegraphUpdate")).toContain("uv tool install graphifyy");
    }
  });

  it("Show still opens the graph, and the update sheet cannot start", () => {
    setCodeGraphStatus("s-1", NOT_INSTALLED);
    pressCodeGraphRow("show", "s-1");
    expect(takeCodeGraphOpen("s-1")).toBe(true);
    const html = renderToStaticMarkup(
      <CodeGraphSheet status={NOT_INSTALLED} sessionId="s-1" view="build" mode="update" onClose={noop} />,
    );
    expect(/<button[^>]*data-codegraph-start[^>]*>/.exec(html)?.[0]).toContain("disabled");
    expect(html).toContain("uv tool install graphifyy");
  });
});

describe("the German strings", () => {
  it("name both rows in German in the menu and on the chip", () => {
    expect(t("de", "hdr.menu.codegraphShow")).toBe("Code-Graph anzeigen");
    expect(t("de", "hdr.menu.codegraphUpdate")).toBe("Code-Graph aktualisieren");
    expect(t("de", "wchip.codegraphShow")).toBe("Code-Graph anzeigen");
    expect(t("de", "wchip.codegraphUpdate")).toBe("Code-Graph aktualisieren");
    expect(t("de", "cg.titleUpdate")).toBe("Code-Graph aktualisieren");
    expect(t("en", "hdr.menu.codegraphShow")).toBe("Show code graph");
    expect(t("en", "wchip.codegraphUpdate")).toBe("Update code graph");
  });
});

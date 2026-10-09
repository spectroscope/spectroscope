// Card 472: the header line while a build runs, the chip when it ends, and
// what pressing the chip does: open graph.html of the session's folder in the
// internal browser panel, through the server's own address.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeGraphHeaderStatus, openGraphInBrowser, pressChip } from "./CodeGraphHeaderStatus";
import { resetCodeGraphForTest, setCodeGraphStatus, codeGraphState } from "./codeGraphStore";
import type { CodeGraphJob, CodeGraphStatus } from "./codeGraphModel";
import { takeCodeGraphOpen } from "../state/browserOpen";
import { dockModes } from "../panels/dockModel";
import { __resetForTests, getLayout } from "../state/layout";

const JOB: CodeGraphJob = {
  folder: "/work/project",
  sessionId: "s-1",
  mode: "update",
  state: "running",
  startedAt: "2026-10-09T10:00:00Z",
  endedAt: null,
  exitCode: null,
  lastLine: "Re-extracting code files",
  tail: ["Re-extracting code files"],
};

const STATUS: CodeGraphStatus = {
  installed: true,
  binary: "/opt/tools/graphify",
  searched: [],
  install: "uv tool install graphifyy",
  folder: "/work/project",
  graph: { exists: false, modifiedAt: null },
  job: null,
  backends: [],
};

const html = (): string => renderToStaticMarkup(<CodeGraphHeaderStatus />);

afterEach(() => resetCodeGraphForTest());
beforeEach(() => __resetForTests());

describe("the header while a build runs", () => {
  it("draws a status line with the build, its start and its last line, and no chip", () => {
    setCodeGraphStatus("s-1", { ...STATUS, job: JOB });
    const out = html();
    expect(out).toContain('role="status"');
    expect(out).toContain("Building code graph");
    expect(out).toContain("Re-extracting code files");
    expect(out).not.toContain("data-codegraph-chip");
  });
});

describe("the chip", () => {
  it("appears when the build has ended well", () => {
    setCodeGraphStatus("s-1", {
      ...STATUS,
      job: { ...JOB, state: "ok", endedAt: "2026-10-09T10:02:00Z", exitCode: 0 },
      graph: { exists: true, modifiedAt: "2026-10-09T10:02:00Z" },
    });
    const out = html();
    expect(out).toContain('data-codegraph-chip="ready"');
    expect(out).toContain("Graph ready");
  });

  it("appears on session open for a graph that already exists", () => {
    setCodeGraphStatus("s-1", { ...STATUS, graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" } });
    expect(html()).toContain('data-codegraph-chip="ready"');
  });

  it("says the build failed when it did", () => {
    setCodeGraphStatus("s-1", { ...STATUS, job: { ...JOB, state: "failed", exitCode: 1 } });
    const out = html();
    expect(out).toContain('data-codegraph-chip="failed"');
    expect(out).toContain("Graph failed");
  });

  it("keeps the ready chip for an existing graph beside the failed chip of a later build", () => {
    setCodeGraphStatus("s-1", {
      ...STATUS,
      job: { ...JOB, state: "failed", exitCode: 1 },
      graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" },
    });
    const out = html();
    expect(out).toContain('data-codegraph-chip="failed"');
    expect(out).toContain('data-codegraph-chip="ready"');
    expect(out.indexOf('data-codegraph-chip="failed"')).toBeLessThan(
      out.indexOf('data-codegraph-chip="ready"'),
    );
  });

  it("is absent with nothing to show", () => {
    setCodeGraphStatus("s-1", STATUS);
    expect(html()).toBe("");
  });

  it("asks the session's browser panel to open the graph; the server mints the ticket and builds the address", () => {
    expect(dockModes(getLayout()).browser).toBe("closed");
    openGraphInBrowser("s-1");
    expect(takeCodeGraphOpen("s-2")).toBe(false);
    expect(takeCodeGraphOpen("s-1")).toBe(true);
    expect(takeCodeGraphOpen("s-1")).toBe(false);
    expect(dockModes(getLayout()).browser).not.toBe("closed");
  });

  it("opens the failure sheet when the build failed, and the browser stays as it was", () => {
    pressChip({ kind: "failed", graph: null }, "s-1");
    expect(codeGraphState().sheet).toBe("failure");
    expect(takeCodeGraphOpen("s-1")).toBe(false);
  });

  it("opens the browser and no sheet when the graph is ready", () => {
    pressChip({ kind: "ready", at: null }, "s-1");
    expect(codeGraphState().sheet).toBeNull();
    expect(takeCodeGraphOpen("s-1")).toBe(true);
  });
});

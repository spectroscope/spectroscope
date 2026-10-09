// Card 472: the sheet behind "Build code graph". Full build or update, the
// backend and model for community names from the harness's own providers with
// "No labels" as an option, and a Start button; when graphify is missing it
// says how to install it. The failure view shows the last twenty lines.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeGraphSheet } from "./CodeGraphSheet";
import type { CodeGraphJob, CodeGraphStatus } from "./codeGraphModel";

const STATUS: CodeGraphStatus = {
  installed: true,
  binary: "/opt/tools/graphify",
  searched: ["/opt/homebrew/bin", "/usr/bin"],
  install: "uv tool install graphifyy",
  folder: "/work/project",
  graph: { exists: false, modifiedAt: null },
  job: null,
  backends: [
    { provider: "anthropic", backend: "claude", ready: false, reason: "no key saved for anthropic" },
    { provider: "ollama", backend: "ollama", ready: true, reason: null },
  ],
};

const JOB: CodeGraphJob = {
  folder: "/work/project",
  sessionId: "s-1",
  mode: "full",
  state: "running",
  startedAt: "2026-10-09T10:00:00Z",
  endedAt: null,
  exitCode: null,
  lastLine: "scanning",
  tail: ["scanning"],
};

const sheet = (status: CodeGraphStatus | null, view: "build" | "failure" = "build"): string =>
  renderToStaticMarkup(<CodeGraphSheet status={status} sessionId="s-1" view={view} onClose={() => {}} />);

/** The whole radio tag of one mode; React orders its attributes, so the test does not. */
const radio = (html: string, value: string): string =>
  [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`value="${value}"`)) ?? "";

const startButton = (html: string): string => /<button[^>]*data-codegraph-start[^>]*>/.exec(html)?.[0] ?? "";

describe("the build sheet", () => {
  it("is a dialog named Build code graph that shows the folder", () => {
    const html = sheet(STATUS);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Build code graph");
    expect(html).toContain("/work/project");
  });

  it("offers a full build first for a folder without a graph", () => {
    const html = sheet(STATUS);
    expect(radio(html, "full")).toContain("checked");
    expect(radio(html, "update")).not.toContain("checked");
  });

  it("offers update first for a folder that has a graph", () => {
    const html = sheet({ ...STATUS, graph: { exists: true, modifiedAt: "2026-10-08T07:30:00Z" } });
    expect(radio(html, "update")).toContain("checked");
    expect(radio(html, "full")).not.toContain("checked");
  });

  it("lists No labels first, then the harness providers, one not ready greyed out with its reason", () => {
    const html = sheet(STATUS);
    const options = [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)];
    expect(options[0][2]).toBe("No labels");
    expect(options.map((o) => o[2])).toEqual(["No labels", "anthropic (claude)", "ollama (ollama)"]);
    expect(options[1][1]).toContain("disabled");
    expect(html).toContain("no key saved for anthropic");
    expect(options[2][1]).not.toContain("disabled");
  });

  it("has a Start button that can start a build", () => {
    expect(startButton(sheet(STATUS))).not.toContain("disabled");
  });

  it("explains the install line and cannot start when graphify is missing", () => {
    const html = sheet({ ...STATUS, installed: false, binary: null });
    expect(html).toContain("uv tool install graphifyy");
    expect(html).toContain("graphify is not installed");
    expect(startButton(html)).toContain("disabled");
  });

  it("cannot start a second build while one runs", () => {
    const html = sheet({ ...STATUS, job: JOB });
    expect(startButton(html)).toContain("disabled");
    expect(html).toContain("A build is running");
  });
});

describe("the failure sheet", () => {
  it("shows the last twenty lines of the failed build", () => {
    const tail = Array.from({ length: 20 }, (_, i) => `line ${i + 6}`);
    const html = sheet({ ...STATUS, job: { ...JOB, state: "failed", exitCode: 2, tail } }, "failure");
    expect(html).toContain("Code graph failed");
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
    expect(pre.split("\n")).toHaveLength(20);
    expect(pre.split("\n")[0]).toBe("line 6");
    expect(pre.split("\n")[19]).toBe("line 25");
    expect(html).toContain("exit 2");
  });
});

// Card 430, review of criterion 9: App draws every lazy view inside a
// ChunkBoundary, so a chunk that does not arrive takes down its own place and
// not the window. Read from App's syntax tree: each JSX use of a view that
// surfaceChunks.ts makes lazy must have a ChunkBoundary among its ancestors.
// The hidden trace needs its boundary INSIDE the element that hides it, or a
// failed warm-up would draw its notice under the chat.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const APP = read("../App.tsx", import.meta.url);
const SF = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The names surfaceChunks.ts exports as lazy components. */
const LAZY = [
  ...stripComments(read("./surfaceChunks.ts", import.meta.url)).matchAll(/export const (\w+) = lazy\(/g),
].map((m) => m[1]);

type Tagged = ts.JsxElement | ts.JsxSelfClosingElement;
const tagOf = (node: Tagged): string =>
  (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(SF);

/** Every JSX element in App, depth first. */
function elements(): Tagged[] {
  const out: Tagged[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(SF);
  return out;
}

/** The tags of the JSX elements around `node`, nearest first. */
function ancestors(node: ts.Node): string[] {
  const out: string[] = [];
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isJsxElement(n)) out.push(tagOf(n));
  }
  return out;
}

const line = (node: ts.Node): number => SF.getLineAndCharacterOfPosition(node.getStart(SF)).line + 1;

describe("App puts every lazy view under a ChunkBoundary", () => {
  it("reads the lazy views off surfaceChunks.ts, and finds each one drawn in App", () => {
    expect(LAZY.length).toBeGreaterThanOrEqual(13);
    const drawn = new Set(elements().map(tagOf));
    for (const name of LAZY) expect(drawn.has(name), name).toBe(true);
  });

  it("draws no lazy view without a ChunkBoundary above it", () => {
    const bare = elements()
      .filter((el) => LAZY.includes(tagOf(el)))
      .filter((el) => !ancestors(el).includes("ChunkBoundary"))
      .map((el) => `${tagOf(el)} at App.tsx:${line(el)}`);
    expect(bare).toEqual([]);
  });

  it("keeps no Suspense of its own, since the boundary carries one", () => {
    expect(
      elements()
        .filter((el) => tagOf(el) === "Suspense")
        .map(line),
    ).toEqual([]);
  });

  it("puts the hidden trace's boundary inside the element that hides it", () => {
    const traces = elements().filter((el) => tagOf(el) === "TraceView");
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) {
      const up = ancestors(trace);
      const boundary = up.indexOf("ChunkBoundary");
      const hider = up.indexOf("div");
      if (hider === -1) continue;
      expect(boundary, `TraceView at App.tsx:${line(trace)}`).toBeGreaterThanOrEqual(0);
      expect(boundary, `TraceView at App.tsx:${line(trace)}: the boundary sits outside its div`).toBeLessThan(
        hider,
      );
    }
  });
});

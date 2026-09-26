// Card 430, review of criterion 9: a view whose chunk does not arrive (a window
// left open across a server upgrade, then switched to learn) shows a notice
// with a reload in its own place, and the rest of the window stays. Without a
// boundary React 19 unmounts the whole root and the window goes blank.
//
// No DOM here. React routes a thrown error to getDerivedStateFromError; these
// tests call that and render() the way React does, and the markup comes from
// React's server renderer.

import { Suspense, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../state/lang";
import { ChunkLoadError } from "../state/surfaceChunks";
import { drive } from "../testkit/driveComponent";
import { ChunkBoundary, ChunkFailed } from "./ChunkBoundary";

afterEach(() => setLang("en"));

/** A boundary in the state React leaves it in after `error` was thrown below it. */
function failedWith(error: unknown, resetKey?: string): ChunkBoundary {
  const boundary = new ChunkBoundary({ children: <b>view</b>, resetKey });
  boundary.state = { ...boundary.state, ...ChunkBoundary.getDerivedStateFromError(error) };
  return boundary;
}

const lost = (): ChunkLoadError =>
  new ChunkLoadError("components/TraceView", new TypeError("Failed to fetch dynamically imported module"));

describe("a boundary with nothing failed", () => {
  it("draws its children inside a Suspense that shows nothing while the chunk loads", () => {
    const boundary = new ChunkBoundary({ children: <b>view</b> });
    const out = boundary.render() as ReactElement<{ fallback: unknown; children: unknown }>;
    expect(out.type).toBe(Suspense);
    expect(out.props.fallback).toBeNull();
    expect(renderToStaticMarkup(<ChunkBoundary>{<b>view</b>}</ChunkBoundary>)).toBe("<b>view</b>");
  });
});

describe("a view whose chunk did not load", () => {
  it("is replaced by a notice with a reload, in English and German", () => {
    const en = renderToStaticMarkup(failedWith(lost()).render() as ReactElement);
    expect(en).toContain('role="alert"');
    expect(en).toContain("This view did not load. Reload the window to fetch it again.");
    expect(en).toMatch(/<button type="button" class="ghost">Reload the window<\/button>/);
    expect(en).not.toContain("<b>view</b>");
    setLang("de");
    const de = renderToStaticMarkup(failedWith(lost()).render() as ReactElement);
    expect(de).toContain(
      "Diese Ansicht wurde nicht geladen. Lade das Fenster neu, um sie noch einmal zu holen.",
    );
    expect(de).toContain(">Fenster neu laden</button>");
  });

  it("reloads the window from the notice's button", () => {
    let reloads = 0;
    drive(
      <ChunkFailed reload={() => reloads++} />,
      [ChunkFailed],
      [
        (tree) => {
          const button = tree.find((el) => el.type === "button");
          expect(button).toBeDefined();
          button!.props.onClick?.();
        },
      ],
    );
    expect(reloads).toBe(1);
  });

  it("forgets the failure once the view it holds changes, and keeps it while the view stays", () => {
    const boundary = failedWith(lost(), "trace");
    expect(
      ChunkBoundary.getDerivedStateFromProps({ children: null, resetKey: "trace" }, boundary.state),
    ).toBeNull();
    const next = ChunkBoundary.getDerivedStateFromProps({ children: null, resetKey: "chat" }, boundary.state);
    expect(next).toEqual({ failure: null, resetKey: "chat" });
  });
});

describe("any other error", () => {
  it("goes on up from the boundary, the way it went before there was one", () => {
    const boom = new Error("a render bug, not a missing chunk");
    expect(() => failedWith(boom).render()).toThrow(boom);
    const odd = { reason: "not an Error at all" };
    let thrown: unknown;
    try {
      failedWith(odd).render();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(odd);
  });
});

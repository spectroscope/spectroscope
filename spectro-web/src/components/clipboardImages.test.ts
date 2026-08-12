// What a paste is offering, decided as a pure function.
//
// This suite exists because the real event cannot be tested here: spectro-web
// runs 227 test files in plain Node with no DOM, and adding jsdom would still
// not help — it implements neither `ClipboardEvent.clipboardData` nor
// `createImageBitmap`. So the ONE decision the paste handler makes ("is this
// paste offering pictures, and which ones") lives in a module that takes plain
// objects, and the handler around it is three lines of wiring the drift test
// reads off disk instead.

import { describe, expect, it } from "vitest";
import { pastedImageFiles } from "./clipboardImages";
import type { ClipboardItemLike } from "./clipboardImages";

/** A clipboard item carrying a file, as the browser hands it over. */
function fileItem(name: string, type: string): ClipboardItemLike {
  const file = { name, type } as File;
  return { kind: "file", type, getAsFile: () => file };
}

/** A clipboard item carrying a string (text/plain, text/html, …). */
function stringItem(type: string): ClipboardItemLike {
  return { kind: "string", type, getAsFile: () => null };
}

describe("pastedImageFiles", () => {
  it("takes the screenshot a plain image paste offers", () => {
    const files = pastedImageFiles([fileItem("shot.png", "image/png")]);
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
  });

  it("ignores a text paste so the browser's own paste survives", () => {
    // The handler only calls preventDefault on a non-empty result. An empty
    // array here IS "let the browser paste the text", so this assertion is the
    // whole guarantee that ⌘V still types.
    expect(pastedImageFiles([stringItem("text/plain")])).toEqual([]);
  });

  it("takes the picture and drops the markup when a web page offers both", () => {
    // Copying an image out of a web page puts text/html on the clipboard
    // alongside the file, and the markup comes FIRST. Anyone doing this means
    // the picture.
    const files = pastedImageFiles([
      stringItem("text/html"),
      stringItem("text/plain"),
      fileItem("from-page.jpg", "image/jpeg"),
    ]);
    expect(files.map((f) => f.name)).toEqual(["from-page.jpg"]);
  });

  it("keeps clipboard order when several images arrive at once", () => {
    const files = pastedImageFiles([
      fileItem("a.png", "image/png"),
      fileItem("b.png", "image/png"),
      fileItem("c.webp", "image/webp"),
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.png", "b.png", "c.webp"]);
  });

  it("survives an item whose getAsFile returns null", () => {
    // getAsFile is allowed to return null even for kind "file" — a dragged-away
    // item, a revoked blob. Dereferencing that is a TypeError inside an event
    // handler, which is exactly the shape of crash nobody sees until a user
    // reports "the composer freezes sometimes".
    const ghost: ClipboardItemLike = { kind: "file", type: "image/png", getAsFile: () => null };
    const files = pastedImageFiles([ghost, fileItem("real.png", "image/png")]);
    expect(files.map((f) => f.name)).toEqual(["real.png"]);
  });

  it("does not take an image type that is only markup on the clipboard", () => {
    // Copying an SVG out of a design tool puts `image/svg+xml` on the clipboard
    // as a STRING, not as a file. The platform promises getAsFile() is null for
    // a string item, and this fixture deliberately BREAKS that promise, because
    // the module must not depend on it: `kind` is the field that says what the
    // item is, and reading the type alone would hand markup to createImageBitmap.
    const markup: ClipboardItemLike = {
      kind: "string",
      type: "image/svg+xml",
      getAsFile: () => ({ name: "drawing.svg", type: "image/svg+xml" }) as File,
    };
    expect(pastedImageFiles([markup])).toEqual([]);
  });

  it("declines a file that is not an image", () => {
    // Copying a PDF is not an attachment offer: the send path is image-only
    // (downscaleImage goes through createImageBitmap).
    expect(pastedImageFiles([fileItem("notes.pdf", "application/pdf")])).toEqual([]);
  });

  it("keeps looking after a non-image file instead of giving up on the paste", () => {
    // Selecting a PDF and a screenshot together in Finder and copying puts both
    // on the clipboard, PDF first. Stopping at the first item that does not fit
    // would silently drop the screenshot — a paste that does nothing, with no
    // error, which reads as a broken composer.
    const files = pastedImageFiles([
      fileItem("notes.pdf", "application/pdf"),
      fileItem("shot.png", "image/png"),
    ]);
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
  });
});

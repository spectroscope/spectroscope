// Card 483: undo and redo from the keyboard, and never while a text field has
// the focus, where the same keys belong to the field.

import { describe, expect, it } from "vitest";
import { editorKeyIntent } from "./keys";

const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const CANVAS = { tagName: "DIV", isContentEditable: false };

describe("the editor's keys", () => {
  it("reads Cmd plus z and Ctrl plus z as undo", () => {
    expect(editorKeyIntent(key("z", { metaKey: true }), CANVAS)).toBe("undo");
    expect(editorKeyIntent(key("z", { ctrlKey: true }), CANVAS)).toBe("undo");
    expect(editorKeyIntent(key("z", { metaKey: true }), null)).toBe("undo");
  });

  it("reads Shift plus Cmd plus Z and Ctrl plus y as redo", () => {
    expect(editorKeyIntent(key("Z", { metaKey: true, shiftKey: true }), CANVAS)).toBe("redo");
    expect(editorKeyIntent(key("z", { ctrlKey: true, shiftKey: true }), CANVAS)).toBe("redo");
    expect(editorKeyIntent(key("y", { ctrlKey: true }), CANVAS)).toBe("redo");
  });

  it("leaves Alt combinations and a plain z alone", () => {
    expect(editorKeyIntent(key("z", { metaKey: true, altKey: true }), CANVAS)).toBeNull();
    expect(editorKeyIntent(key("z"), CANVAS)).toBeNull();
    expect(editorKeyIntent(key("y"), CANVAS)).toBeNull();
  });

  it("leaves every shortcut to a text field that has the focus", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      const field = { tagName, isContentEditable: false };
      expect(editorKeyIntent(key("z", { metaKey: true }), field), tagName).toBeNull();
      expect(editorKeyIntent(key("Z", { metaKey: true, shiftKey: true }), field), tagName).toBeNull();
      expect(editorKeyIntent(key("y", { ctrlKey: true }), field), tagName).toBeNull();
    }
    const editable = { tagName: "DIV", isContentEditable: true };
    expect(editorKeyIntent(key("z", { ctrlKey: true }), editable)).toBeNull();
  });
});

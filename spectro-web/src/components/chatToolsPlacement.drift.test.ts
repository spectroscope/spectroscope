// Where the chat's controls are mounted, read off disk.
//
// Placement lives in JSX and this suite has no renderer, by house rule. What it
// CAN see is the source text: how many times a control is mounted, which props
// it is handed, and whether a stylesheet still carries a rule for an element
// that no longer exists. Those are exactly the three ways this change can rot.
//
// The owner's report was that a control cluster floating over the first message
// is ugly. The fix moves the export and the translation trigger into the bottom
// bar and deletes the floating row. Three of these tests guard the deletion;
// three guard against a second copy creeping back; the last one guards the
// wiring that makes the export honest, and it passed before this change too.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

const chatTsx = read("./Chat.tsx");
const translateTsx = read("./TranslatePanel.tsx");
const appTsx = read("../App.tsx");
const chatCss = read("../styles/chat.css");
const panelsCss = read("../styles/panels.css");

describe("the floating control cluster is gone", () => {
  it("leaves no positioned row in the chat", () => {
    expect(chatTsx).not.toContain("chat-disc");
  });

  it("leaves no rule behind for it", () => {
    // A rule that matches no element is worse than no rule: the next reader
    // assumes it is load bearing and styles around it.
    expect(chatCss).not.toContain("chat-disc");
    expect(panelsCss).not.toContain("chat-disc");
  });

  it("keeps the chat a positioning context all the same", () => {
    // .chat-rail is absolute inside .chat, so `position: relative` must stay.
    // Only the comment crediting it to the floating menu becomes false.
    expect(chatCss).toContain("position: relative");
    expect(chatCss).not.toContain("anchors the floating disclosure menu");
  });
});

describe("one control, one mount", () => {
  it("mounts the disclosure menu once, in the composer row", () => {
    expect(mounts(chatTsx, "DisclosureMenu")).toBe(1);
  });

  it("mounts the export control once in the chat", () => {
    expect(mounts(chatTsx, "ExportMenu")).toBe(1);
  });

  it("mounts the translation trigger once in the chat", () => {
    expect(mounts(chatTsx, "TranslatePanel")).toBe(1);
  });

  it("leaves the toggle to the tab row and the sheet, not the trigger row", () => {
    // The tab row's copy is deliberate and documented: it reaches the trace and
    // the text feed too, and it reads App.tsx's viewKey rather than the chat's
    // fallback. The sheet keeps its own. The trigger row's copy is the spare.
    expect(mounts(translateTsx, "TranslateToggle")).toBe(1);
    expect(mounts(appTsx, "TranslateToggle")).toBe(1);
  });
});

describe("the export still sees the view the reader is on", () => {
  it("hands the export control the same key the translate sheet is given", () => {
    // Without it the export cannot tell that a translation is showing, and
    // would write the recorded stream under a label promising the screen.
    const exportLine = chatTsx.split("\n").find((l) => l.includes("<ExportMenu"));
    const translateLine = chatTsx.split("\n").find((l) => l.includes("<TranslatePanel"));
    expect(exportLine).toContain("viewKey={vk}");
    expect(translateLine).toContain("viewKey={vk}");
  });
});

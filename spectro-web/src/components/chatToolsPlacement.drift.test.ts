// Where the chat's controls are mounted, read off disk.
//
// Placement lives in JSX and this suite has no renderer, by house rule. What it
// CAN see is the source text: how many times a control is mounted, which props
// it is handed, and whether a stylesheet still carries a rule for an element
// that no longer exists. Those are exactly the three ways this change can rot.
//
// The owner's report was that a control cluster floating over the first message
// is ugly. The fix moves the export and the translation trigger into the bottom
// bar and deletes the floating row. Three of these tests guard the deletion,
// three guard against a second copy creeping back, and one guards the wiring
// that makes the export honest.
//
// The rest were written after that move cost the archive branch its disclosure
// menu, because the deleted row was the copy the archive rendered: they read
// the two arms of the composer ternary separately, so "the chat has a control"
// can no longer stand in for "both screens have it", and they hold the prose
// and the labels around the moved row to what the code now does.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";
import { t } from "../i18n/i18n";

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

/**
 * The two arms of Chat.tsx's `{liveView ? ( … ) : ( … )}` composer render.
 *
 * A control mounted inside one arm exists on one of the two screens only, and
 * reading the file top to bottom does not show that: the arms are 150 lines
 * apart. Splitting the text is the only way this rendererless suite can tell
 * "the chat has it" from "the live chat has it".
 *
 * @param src Chat.tsx as text
 * @return the live arm and the archive arm, each as text
 */
function composerArms(src: string): { live: string; archive: string } {
  const open = src.indexOf("{liveView ? (");
  const split = src.indexOf("\n      ) : (\n", open);
  const close = src.indexOf("\n      )}\n", split);
  if (open < 0 || split < 0 || close < 0) {
    throw new Error("Chat.tsx no longer renders one `{liveView ? ( … ) : ( … )}` composer");
  }
  return { live: src.slice(open, split), archive: src.slice(split, close) };
}

const chatTsx = read("./Chat.tsx", import.meta.url);
const chatToolsTs = read("./chatTools.ts", import.meta.url);
const translateTsx = read("./TranslatePanel.tsx", import.meta.url);
const appTsx = read("../App.tsx", import.meta.url);
const chatCss = read("../styles/chat.css", import.meta.url);
const panelsCss = read("../styles/panels.css", import.meta.url);

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
    //
    // Scoped to the .chat block on purpose: chat.css declares `position:
    // relative` three times (list markers, the thinking toggle track), so a
    // bare substring check passes with .chat's own declaration deleted, which
    // is the one failure this test exists to catch. Proven by deleting it.
    expect(chatCss).toMatch(/\.chat \{[^}]*position: relative/);
    expect(chatCss).not.toContain("anchors the floating disclosure menu");
  });
});

describe("one control, one mount", () => {
  it("mounts the disclosure menu once, and hands that one mount to both bars", () => {
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

describe("both bars reach the same controls", () => {
  const arms = composerArms(chatTsx);

  it("renders the tools row on an archive as well as on a live session", () => {
    expect(arms.live).toContain("{toolsRow}");
    expect(arms.archive).toContain("{toolsRow}");
  });

  it("renders the disclosure menu on an archive as well as on a live session", () => {
    // The menu is the only route to the disclosure level, the reading width and
    // the chat reading. All three describe how a session is READ, and reading
    // someone else's record is what the archive branch is for, so a menu that
    // exists only while a run is live is missing from the screen that needs it.
    expect(arms.live).toContain("{discMenu}");
    expect(arms.archive).toContain("{discMenu}");
  });

  it("decides the tools row without asking which bar is on screen", () => {
    // This replaces an assertion in chatTools.test.ts that compared the
    // function to itself and therefore held for every implementation. The
    // guarantee is structural, not numeric: the input is two counts and no
    // liveView, so no implementation can answer differently for an archive.
    expect(chatToolsTs).toMatch(
      /export function chatTools\(input: \{ events: number; translatedUnits: number \}\)/,
    );
  });
});

describe("the archive bar tells its two exports apart", () => {
  it("gives them different words in both languages", () => {
    // The archive bar's own export sits a click away from the one in the menu
    // (card 255 made the menu the tools' only home; before that they were one
    // line apart). They do different things: the menu's trigger opens the
    // format dialog and writes the view on screen, the bar's link downloads the
    // stored .jsonl verbatim.
    // German capitalises the nominalised infinitive, so the comparison that
    // matters is case-insensitive.
    for (const lang of ["de", "en"] as const) {
      const dialog = t(lang, "exp.button").toLowerCase();
      const rawFile = t(lang, "arch.export").toLowerCase();
      expect(rawFile, `${lang}: the archive download reads like the format dialog`).not.toBe(dialog);
    }
  });

  it("names the file the archive download hands over", () => {
    expect(t("en", "arch.export")).toContain(".jsonl");
    expect(t("de", "arch.export")).toContain(".jsonl");
  });
});

describe("the suppressed row is not the only mount", () => {
  // This replaces the assertion that the archive bar centred its tools row
  // where the bar below it centres. That was a claim about two visible rows
  // sharing an axis, and card 255 leaves one of them invisible at every width,
  // so the claim describes nothing a reader can see. The rule it pinned is
  // deleted rather than loosened, and what takes its place is the failure that
  // the new arrangement actually has.

  it("hands the chips the row builds to the menu as well", () => {
    // The row's copy is `display: none` at every width now, so the menu's
    // section is the only copy anybody can reach. Lose the fold wiring and the
    // chips still MOUNT — the markup tests above stay green, the export
    // control and the translation trigger simply stop existing on screen.
    expect(chatTsx).toMatch(/const toolsRow = [\s\S]{0,240}\{toolsChips\}/);
    expect(chatTsx).toMatch(/<DisclosureMenu\s+fold=\{toolsChips\b/);
  });

  it("keeps the section away from a chat that has no tools", () => {
    // The exact call shape, because the narrowing IS the behaviour: on an empty
    // chat `toolsChips` is `false`, and a `false` handed to an optional
    // ReactNode prop would draw the section head over nothing. `undefined` is
    // what makes DisclosureMenu leave the section out.
    expect(chatTsx).toContain("fold={toolsChips !== false ? toolsChips : undefined}");
  });
});

describe("the comments no longer promise a toggle that was deleted", () => {
  it("does not send a reader to the trigger row for the way back", () => {
    expect(translateTsx).not.toContain("next to the trigger in the chat header");
    expect(translateTsx).not.toContain("TranslateToggle sits next");
    expect(appTsx).not.toContain("same toggle next to the translate trigger");
  });

  it("does not call the trigger's home a chat header", () => {
    // The trigger moved into the composer's tools row with the same commit that
    // deleted the toggle beside it, and the row renders on archives too, so
    // both halves of the old sentence are false.
    expect(translateTsx).not.toContain("chat header");
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

// Where the pasted thumbnails are mounted, and what the paste is wired to.
// Read off disk, like the other drift suites — this tree has no renderer and no
// DOM, by house rule.
//
// The owner asked for the thumbnails INSIDE the composer's border with the
// caret continuing below them, which turns .composer-box from a row into a
// column. Two documented failure modes sit right next to that edit and neither
// of them is visible in a diff:
//
//   1. .composer-field is the positioned ancestor of the live-dictation ghost
//      (modal-composer.css). If the thumbs land inside it, the ghost drifts
//      down by the strip's height while someone is speaking.
//   2. The growth math is pure lines-plus-padding with no border term
//      (Chat.tsx, composerGrowth.ts). If anything measured lands inside the
//      textarea, `scrollHeight` stops meaning lines and the 240px cap stops
//      meaning ten of them.
//
// So the strip must sit inside the BOX and outside the FIELD, and that is a
// statement about source order this suite can actually check.

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
 * Same splitter as chatToolsPlacement.drift.test.ts, and here for the same
 * reason: the archive arm is read-only, so a control that reaches it is a
 * defect, and reading the file top to bottom cannot tell the arms apart.
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
const arms = composerArms(chatTsx);
const composerCss = read("../styles/modal-composer.css", import.meta.url);
const attachCss = read("../styles/attachments-voice.css", import.meta.url);
const useAttachmentsTs = read("./useAttachments.ts", import.meta.url);
const thumbsTsx = read("./AttachmentThumbs.tsx", import.meta.url);

describe("the thumbnails live inside the composer's border", () => {
  it("mounts the thumbnails inside the box, not above it", () => {
    const box = arms.live.indexOf('<div className="composer-box">');
    const thumbs = arms.live.indexOf("<AttachmentThumbs");
    const row = arms.live.indexOf('<div className="composer-row">');
    expect(box, "the composer box").toBeGreaterThan(-1);
    expect(thumbs, "the thumbnail strip").toBeGreaterThan(-1);
    expect(row, "the row that carries field and seat").toBeGreaterThan(-1);
    expect(thumbs).toBeGreaterThan(box);
    expect(thumbs).toBeLessThan(row);
  });

  it("keeps the ghost's anchor wrapped around the textarea alone", () => {
    // From the field's opening tag to the seat that follows it: the ghost and
    // the textarea, and nothing else with a height.
    const from = arms.live.indexOf('<div className="composer-field">');
    const to = arms.live.indexOf("composer-seat", from);
    expect(from, "the field").toBeGreaterThan(-1);
    expect(to, "the action seat after the field").toBeGreaterThan(from);
    expect(arms.live.slice(from, to)).not.toContain("AttachmentThumbs");
  });

  it("keeps the strip a sibling of the textarea, so scrollHeight still counts lines", () => {
    // The strip closes before the textarea opens. If it did not, the growth
    // math would measure pictures as text.
    const thumbs = arms.live.indexOf("<AttachmentThumbs");
    const textarea = arms.live.indexOf("<textarea");
    expect(textarea).toBeGreaterThan(thumbs);
    expect(arms.live.slice(thumbs, textarea)).toContain("/>");
  });

  it("wires the paste handler to the textarea, not the chat root", () => {
    // A paste into the search box or the workspace terminal must not be
    // hijacked, so the handler belongs on the draft itself.
    // `onPaste=` is the WIRING; the bare name also appears as the handler it
    // is wired to, so only the prop counts.
    expect(chatTsx.split("onPaste=").length - 1, "one onPaste= in the file").toBe(1);
    const textarea = chatTsx.indexOf("<textarea");
    const end = chatTsx.indexOf("/>", textarea);
    expect(chatTsx.slice(textarea, end)).toContain("onPaste=");
  });

  it("adds nothing to the read-only archive arm", () => {
    expect(arms.archive).not.toContain("onPaste");
    expect(arms.archive).not.toContain("AttachmentThumbs");
  });

  it("lets a pasted image be thrown out again before it is sent", () => {
    // "a pasted image can be removed before sending" is half the ask. The
    // strip reaches the existing removeAt rather than minting a second one.
    expect(arms.live).toContain("attachments.removeAt");
    expect(thumbsTsx).toContain("onRemove");
  });

  it("replaced the chips rather than growing a second strip beside them", () => {
    expect(mounts(chatTsx, "AttachmentPreview")).toBe(0);
    expect(mounts(arms.live, "AttachmentThumbs")).toBe(1);
  });

  it("left no orphan rules for the chips it replaced", () => {
    // A rule matching no element is worse than no rule: the next reader styles
    // around it as if it were load bearing.
    for (const dead of [".attach-strip", ".attach-chip", ".attach-meta", ".attach-name", ".attach-size"]) {
      expect(attachCss, dead).not.toContain(dead);
    }
  });

  it("turns the box into a column so the caret continues below the pictures", () => {
    const from = composerCss.indexOf(".composer-box {");
    const to = composerCss.indexOf("}", from);
    expect(from, ".composer-box").toBeGreaterThan(-1);
    expect(composerCss.slice(from, to)).toContain("flex-direction: column");
    expect(composerCss).toContain(".composer-row {");
    expect(composerCss).toContain(".composer-thumbs {");
  });

  it("lines the thumbnails up with the caret", () => {
    // Same horizontal padding as the textarea (--sp-4), or the strip sits
    // visibly left of the text it belongs to.
    const from = composerCss.indexOf(".composer-thumbs {");
    const to = composerCss.indexOf("}", from);
    expect(composerCss.slice(from, to)).toContain("var(--sp-4)");
  });
});

describe("the paste path joins the existing attachment path", () => {
  it("sends a pasted image through the same downscale as a dropped one", () => {
    // No second pipeline: one addFiles, reached by drop, by picker and by
    // paste. The image endpoints (ImageStore, /api/images) are the gallery of
    // GENERATED images and have no upload route at all.
    expect(useAttachmentsTs).toContain("pastedImageFiles");
    expect(useAttachmentsTs.split("downscaleImage(").length - 1, "one downscale call").toBe(1);
    // And it reaches no endpoint of its own: the pictures travel on the send
    // frame the composer already builds, so the intake makes no request at all.
    expect(useAttachmentsTs).not.toContain("fetch(");
  });

  it("lets the browser paste text when the clipboard holds no picture", () => {
    // preventDefault is guarded by a non-empty result. Cancelling every paste
    // would break ⌘V for text, which is the common case by far.
    const from = useAttachmentsTs.indexOf("const onPaste");
    const to = useAttachmentsTs.indexOf("\n  };", from);
    const handler = useAttachmentsTs.slice(from, to);
    expect(from, "the paste handler").toBeGreaterThan(-1);
    expect(handler).toContain("length === 0");
    expect(handler.indexOf("length === 0")).toBeLessThan(handler.indexOf("preventDefault"));
  });

  it("survives an image the browser cannot decode", () => {
    // createImageBitmap rejects on formats the browser will not read (macOS
    // hands out image/tiff), and that was an unhandled rejection on the drag
    // path too. A failed picture must not take the whole paste down.
    expect(useAttachmentsTs).toContain("catch");
    expect(useAttachmentsTs).toContain("chat.attachFailed");
  });

  it("names paste in the attach tooltip, in both languages", () => {
    // The tooltip is the only place the affordance is discoverable.
    expect(t("de", "chat.attach")).toContain("⌘V");
    expect(t("en", "chat.attach")).toContain("⌘V");
  });
});

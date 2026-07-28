// What the text tab is allowed to say about the file it writes.
//
// Card 114 in the chat was the file claiming to be the screen while writing the
// record: the tab rendered the translation and exported the recording. The text
// tab can break the same rule from the other side. It is handed the SHOWN
// stream (App.tsx applies the translation before the tabs fold it) and holds no
// second copy of the run, so a sheet that reads this view's translation state
// while the reader is back on the record prints "translated to de" across the
// record itself.
//
// So the rule is: hand the export control the key to this view's translation
// state exactly while the stream on screen IS the translation.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { composeDocument } from "../export/document";
import { DEFAULT_REQUEST } from "../export/options";
import { emptyTranslation, translatedEvents } from "../state/translate";
import { textExportViewKey } from "./textExportClaim";

const ts = 1_783_500_000_000;

/** Unit ids are `<eventIndex>:<field>` (translate/units.ts). */
const recorded: RunEvent[] = [
  { type: "run_start", runId: "r", agentId: "main", prompt: "hello there", ts },
  { type: "text_delta", agentId: "main", text: "the sky is blue", ts: ts + 1 },
  { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 2 },
] as RunEvent[];

const landed = new Map([
  ["0:prompt", "hallo da"],
  ["1:text", "der himmel ist blau"],
]);

const translating = { ...emptyTranslation("en"), target: "de", byId: landed };

/** The stream App hands the tab, for each side of the toggle. */
const shownTranslation = translatedEvents(recorded, translating);
const shownRecord = translatedEvents(recorded, { ...translating, show: "original" });

/**
 * ExportMenu's own mapping for `kind: "text"`: this tab holds ONE array, so the
 * sheet reads a translation only when a viewKey came in, and then the array it
 * was handed IS the translation. Mirrored here because that mapping lives in a
 * component body and this is the contract it rests on.
 */
function sheetStreams(shown: readonly RunEvent[], key: string | undefined) {
  return key === undefined
    ? { original: shown, translated: null, translatedTo: null }
    : { original: shown, translated: shown, translatedTo: translating.target };
}

function exported(shown: readonly RunEvent[], key: string | undefined): string {
  return composeDocument(
    { ...DEFAULT_REQUEST, kind: "text", views: ["text"], primary: "text", now: ts, label: "demo" },
    sheetStreams(shown, key),
  );
}

describe("the key the text tab hands its export control", () => {
  it("hands it over while the translation is the thing on screen", () => {
    expect(textExportViewKey({ viewKey: "live", showingTranslation: true })).toBe("live");
  });

  it("withholds it while the record is the thing on screen", () => {
    expect(textExportViewKey({ viewKey: "live", showingTranslation: false })).toBeUndefined();
  });

  it("withholds it in a session nobody ever translated", () => {
    expect(textExportViewKey({ viewKey: "20260728-1200", showingTranslation: false })).toBeUndefined();
  });

  it("carries a replay's own key, not a fixed one — every view translates apart", () => {
    expect(textExportViewKey({ viewKey: "20260728-1200", showingTranslation: true })).toBe("20260728-1200");
  });
});

describe("the file and the screen say the same thing", () => {
  it("names the translation as one when the tab is showing it", () => {
    const html = exported(shownTranslation, textExportViewKey({ viewKey: "live", showingTranslation: true }));
    expect(html).toContain("translated to de");
    expect(html).toContain("der himmel ist blau");
    expect(html).not.toContain("the sky is blue");
  });

  it("claims nothing when the tab is showing the record", () => {
    const html = exported(shownRecord, textExportViewKey({ viewKey: "live", showingTranslation: false }));
    expect(html).not.toContain("translated to");
    expect(html).toContain("the sky is blue");
    expect(html).not.toContain("der himmel ist blau");
  });

  it("would print the note over the record if the key were handed over blindly", () => {
    // The defect this rule exists to prevent, spelled out: same stream, key
    // handed over anyway, and the file now claims a translation it does not
    // carry. This is why the call site cannot simply forward viewKey.
    const blind = exported(shownRecord, "live");
    expect(blind).toContain("translated to de");
    expect(blind).toContain("the sky is blue");
  });
});

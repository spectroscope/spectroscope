// Card 463: the provider and model moved from the header to the row under the
// message box, and the first-run sheet told new users to look in the header
// (found by the guide update of 2026-09-29, plate 35). It points at the model
// menu under the message box now, in both languages.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const sheet = stripComments(read("./Onboarding.tsx", import.meta.url));

describe("the first-run sheet points at the model menu where it is", () => {
  it("no longer sends anyone to the header", () => {
    expect(sheet).not.toMatch(/in the header/);
    expect(sheet).not.toMatch(/oben den Anbieter|oben am Anbieter-Chip/);
  });

  it("names the model menu under the message box, in English and German", () => {
    expect(sheet.split("under the message box").length - 1).toBe(3);
    expect(sheet.split("unter dem Nachrichtenfeld").length - 1).toBe(3);
  });
});

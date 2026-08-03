// What the composer's tools row offers, and when it should not be there.
//
// The rules live here rather than in the JSX because the row has to agree with
// the panel it triggers: TranslatePanel already withholds itself on
// `events === 0 && byId.size === 0`, and a row that appeared anyway would draw
// a container around a single button, or around nothing.
//
// The export is the one that changes. Today it mounts always and disables
// itself, which puts a permanently dead button next to Send in the lab's chat
// column, where the component is handed a stepper's projection and no stream of
// its own. A control that can never do anything is not an affordance.

import { describe, expect, it } from "vitest";
import { chatTools } from "./chatTools";

describe("the composer's session tools", () => {
  it("carries both triggers once there is a recorded stream", () => {
    expect(chatTools({ events: 12, translatedUnits: 0 })).toEqual({
      row: true,
      exportControl: true,
      translateControl: true,
    });
  });

  it("carries nothing on an empty chat, so the bar keeps the shape it has", () => {
    expect(chatTools({ events: 0, translatedUnits: 0 })).toEqual({
      row: false,
      exportControl: false,
      translateControl: false,
    });
  });

  it("withholds the export from a view with no stream of its own", () => {
    expect(chatTools({ events: 0, translatedUnits: 4 }).exportControl).toBe(false);
  });

  it("keeps the translation trigger while a translation is showing", () => {
    expect(chatTools({ events: 0, translatedUnits: 4 })).toEqual({
      row: true,
      exportControl: false,
      translateControl: true,
    });
  });

  it("carries them from the first recorded event, not from a comfortable number", () => {
    // The boundary, stated once. What stood here was
    // `expect(chatTools(x)).toEqual(chatTools(x))`, the same pure function
    // compared to itself, which passes for every implementation including one
    // that ignores its input. It was named for the archive-equals-live rule,
    // which has no runtime shape to assert: it is the ABSENCE of a liveView
    // input. That guarantee is now read off the signature in
    // chatToolsPlacement.drift.test.ts, where source text is visible.
    expect(chatTools({ events: 1, translatedUnits: 0 })).toEqual({
      row: true,
      exportControl: true,
      translateControl: true,
    });
  });
});

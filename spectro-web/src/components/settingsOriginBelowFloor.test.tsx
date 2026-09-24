// Card 386, criterion 5: a value below its floor on disk is named where the
// settings page shows the origin of a value.
//
// The server skips such a value on read, so the session runs on the layer
// below, and the view lists what it skipped under `belowFloor`. The origin row
// is where an operator already looks to learn where a number came from.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OriginRow } from "./settingsOrigin";
import { t } from "../i18n/i18n";
import { layerLabel, type SettingsView } from "../state/serverSettings";

function viewWith(extra: Partial<SettingsView>): SettingsView {
  return {
    effective: { commandTimeoutSeconds: 900 },
    origins: { commandTimeoutSeconds: { winner: "defaults", shadowed: [] } },
    layers: {},
    files: {},
    workspace: null,
    ...extra,
  };
}

const USER_FILE = "/home/x/.spectro/settings.json";

const SKIPPED_IN_USER = viewWith({
  files: { user: USER_FILE },
  belowFloor: [
    {
      key: "commandTimeoutSeconds",
      value: "0",
      floor: 1,
      layer: "user",
      file: USER_FILE,
    },
  ],
});

const render = (view: SettingsView, field: string, lang: "en" | "de" = "en"): string =>
  renderToStaticMarkup(<OriginRow view={view} field={field} lang={lang} onReset={() => {}} />);

/** The markup React would render for a text, so an expected sentence compares
 *  with the page's escaping. */
const asMarkup = (text: string): string => renderToStaticMarkup(<>{text}</>);

describe("a value skipped for being below its floor", () => {
  it("is named on its own field's origin row, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const html = render(SKIPPED_IN_USER, "commandTimeoutSeconds", lang);
      const sentence = t(lang, "set.originBelowFloor", {
        value: "0",
        layer: layerLabel("user", lang),
        floor: 1,
      });
      expect(sentence, `${lang}: the sentence falls through to its key`).not.toBe("set.originBelowFloor");
      expect(html, lang).toContain('data-below-floor="commandTimeoutSeconds"');
      expect(html, lang).toContain(asMarkup(sentence));
    }
  });

  it("keeps the badge that says where the value in force comes from", () => {
    expect(render(SKIPPED_IN_USER, "commandTimeoutSeconds")).toContain(t("en", "set.originDefault"));
  });

  it("offers the reset when the skipped value sits in the user settings", () => {
    // The reset clears the key from the user file, which is the one file the
    // page writes. The value is not in the user layer of the view any more,
    // because the read skipped it; the reset has to be offered anyway.
    expect(render(SKIPPED_IN_USER, "commandTimeoutSeconds")).toContain('class="origin-reset"');
  });

  it("offers no reset for the legacy user file, which the reset does not write", () => {
    const inConfigJson = viewWith({
      files: { user: USER_FILE },
      belowFloor: [
        {
          key: "commandTimeoutSeconds",
          value: "0",
          floor: 1,
          layer: "user",
          file: "/home/x/.spectro/config.json",
        },
      ],
    });
    expect(render(inConfigJson, "commandTimeoutSeconds")).not.toContain('class="origin-reset"');
  });

  it("offers no reset for a value skipped in a file the page does not write", () => {
    const inProject = viewWith({
      belowFloor: [
        {
          key: "commandTimeoutSeconds",
          value: "0",
          floor: 1,
          layer: "project",
          file: "/w/.spectro/settings.json",
        },
      ],
    });
    const html = render(inProject, "commandTimeoutSeconds");
    expect(html).toContain('data-below-floor="commandTimeoutSeconds"');
    expect(html).not.toContain('class="origin-reset"');
  });

  it("stays off the rows of other fields", () => {
    expect(render(SKIPPED_IN_USER, "maxTurns")).not.toContain("data-below-floor");
  });

  it("is absent when the view skipped nothing or carries no list", () => {
    expect(render(viewWith({ belowFloor: [] }), "commandTimeoutSeconds")).not.toContain("data-below-floor");
    expect(render(viewWith({}), "commandTimeoutSeconds")).not.toContain("data-below-floor");
  });
});

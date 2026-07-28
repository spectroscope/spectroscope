// The drift gate for the About surface's licence notice.
//
// A licence notice is the one piece of UI copy that may not be edited for
// readability: it states the terms under which someone else may use this
// material, and a friendlier paraphrase grants something different from what
// the repository grants. So the strings are not trusted to a reviewer's memory
// — they are read out of LICENSE and LICENSE-ASSETS.md at test time, the way
// toolBody.drift.test.ts reads the union off disk.
//
// Two failures it exists to catch:
//   - the licence changes and the About keeps showing the old terms (the app
//     would then be publishing a grant the project no longer makes);
//   - someone rewrites the notice to read better and quietly drops a
//     condition. The attribution requirement is the live example: CC BY is
//     conditional, and "Removing the attribution removes your license" is the
//     sentence that makes it a condition rather than a courtesy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABOUT, releaseVersion } from "./about";
import { dict } from "../i18n/i18n";

/** The repo-root licence files, read from the tree this bundle is built out of. */
const licence = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

const LICENSE = licence("LICENSE");
const ASSETS = licence("LICENSE-ASSETS.md");

/** The licence files are hard-wrapped prose, so a clause that reads as one
 *  sentence spans a newline on disk. Comparing the words rather than the
 *  layout is what makes a match mean the clause is still there. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("the About notice against the licence files", () => {
  it("shows the copyright line both licence files carry", () => {
    expect(LICENSE).toContain(ABOUT.copyright);
    expect(ASSETS).toContain(ABOUT.copyright);
  });

  it("shows the attribution line LICENSE-ASSETS.md requires, verbatim", () => {
    // The requirement is a two-line blockquote in the markdown; the string the
    // app hands people has to be the same text on one line.
    const quoted = ASSETS.split("\n")
      .filter((l) => l.startsWith("> "))
      .map((l) => l.slice(2).trim())
      .join(" ");
    expect(quoted).not.toBe("");
    expect(ABOUT.attribution).toBe(quoted);
  });

  it("keeps the condition that makes attribution a condition", () => {
    // Drop this sentence and CC BY reads as a request. It is a term.
    expect(ASSETS).toContain(ABOUT.attributionIsAcondition);
  });

  it("carries the MIT condition in the licence file's own words", () => {
    expect(ASSETS).toContain(ABOUT.codeCondition);
  });

  it("excludes the marks from the CC BY grant, as the file does", () => {
    // LICENSE-ASSETS.md reserves the marks; the About must not blur a
    // trademark position into the image licence.
    expect(ASSETS).toContain(ABOUT.marksReserved);
    expect(ASSETS).toContain(ABOUT.marksIdentify);
  });

  it("links the licences the files themselves point at", () => {
    expect(ASSETS).toContain(ABOUT.ccByUrl);
    expect(ABOUT.repo).toBe("https://github.com/spectroscope/spectroscope");
    expect(ASSETS).toContain(ABOUT.repo);
  });
});

describe("releaseVersion", () => {
  // The client has no version of its own: package.json is stale at 0.1.0 and
  // the bundle is served by whatever server built it. The only honest number
  // is the one that server reports, so anything unusable becomes "show
  // nothing" rather than a plausible guess.
  it("takes a version string the server reported", () => {
    expect(releaseVersion("0.4.1")).toBe("0.4.1");
    expect(releaseVersion(" 0.4.1 ")).toBe("0.4.1");
  });

  it("shows nothing when the server did not say", () => {
    expect(releaseVersion(undefined)).toBeNull();
    expect(releaseVersion(null)).toBeNull();
    expect(releaseVersion("")).toBeNull();
    expect(releaseVersion("   ")).toBeNull();
  });

  it("shows nothing rather than rendering a non-string as one", () => {
    expect(releaseVersion(404)).toBeNull();
    expect(releaseVersion({ version: "0.4.1" })).toBeNull();
  });
});

describe("the About strings are localised", () => {
  it("has a German and an English string for every about.* key", () => {
    const keys = Object.keys(dict).filter((k) => k.startsWith("about."));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(dict[k]?.de, `${k}.de`).toBeTruthy();
      expect(dict[k]?.en, `${k}.en`).toBeTruthy();
    }
  });

  it("has every key the dialog renders (a missing one ships as its own name)", () => {
    for (const k of [
      "about.open",
      "about.title",
      "about.tagline",
      "about.licences",
      "about.code",
      "about.images",
      "about.attributionLabel",
      "about.marks",
      "about.repo",
    ]) {
      expect(dict[k], k).toBeDefined();
    }
  });

  // The defect this file exists to prevent, and it slipped through once: the
  // notice quoted the grant and one of its three conditions. CC BY 4.0 section
  // 3(a)(1)(B) makes marking a change a condition, so a shorter list grants
  // adaptation on lighter terms than the licence the row links to.
  it("keeps every condition the assets licence states, not just attribution", () => {
    const file = flat(ASSETS);
    for (const c of ABOUT.ccByConditions) {
      expect(file, `the assets licence must still say: ${c}`).toContain(c);
    }
    expect(ABOUT.ccByConditions.length).toBe(3);
  });

  // A guide screenshot is CC BY AND carries the wordmark. Without this clause
  // the two rows read as disjoint sets and the carve-out is invisible.
  it("says the marks are carved out of the images themselves", () => {
    expect(flat(ASSETS)).toContain(flat(ABOUT.marksWhereverTheyAppear));
  });

  // A project may waive its own rights and not a third party's terms. Both
  // families ride in this bundle, so a surface headed "licences" that omits
  // them under-reports in the one direction that is not ours to waive.
  it("names the fonts this bundle re-ships, on the terms NOTICE.md carries", () => {
    const notice = flat(licence("spectro-server/src/main/resources/NOTICE.md"));
    for (const f of ABOUT.fonts) {
      expect(notice).toContain(f.name);
      expect(notice).toContain(f.holder);
    }
    expect(notice).toContain(ABOUT.fontsLicence);
  });
});

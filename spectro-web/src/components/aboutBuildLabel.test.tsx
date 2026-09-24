// Card 398: a test build says what it is.
//
// The server reports a build label next to its version in /api/bundles when
// the jar was built as a test build, for example
// "0.13.0-beta (merge-2026-09-24, a1b2c3d, 24.09. 14:05)", and reports none on
// a release. Pinned here: the narrowing of that field, the About line with and
// without a label in both languages, the window title the page sets, and the
// mounts in AboutDialog and main.tsx. The desktop shell keeps every version it
// uses on the plain app version; that half is pinned at the bottom.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AboutIdentity } from "./AboutDialog";
import { buildLabel, windowTitle } from "./about";
import { applyBuildTitle } from "../state/buildTitle";
import { dict } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";
import { shouldClearCache } from "../../../spectro-desktop/src/cacheRecovery";

const LABEL = "0.13.0-beta (merge-2026-09-24, a1b2c3d, 24.09. 14:05)";

describe("buildLabel: the field as it arrives from the server", () => {
  it("takes the label the server reported", () => {
    expect(buildLabel(LABEL)).toBe(LABEL);
    expect(buildLabel(`  ${LABEL} `)).toBe(LABEL);
  });

  it("is null on a release, where the server sends no label", () => {
    expect(buildLabel(undefined)).toBeNull();
    expect(buildLabel(null)).toBeNull();
    expect(buildLabel("")).toBeNull();
    expect(buildLabel("   ")).toBeNull();
    expect(buildLabel(42)).toBeNull();
  });
});

describe("the About identity line", () => {
  const html = (version: string | null, label: string | null, lang: "de" | "en"): string =>
    renderToStaticMarkup(<AboutIdentity version={version} label={label} lang={lang} />);

  it("shows the plain version and no test build line on a release", () => {
    const out = html("0.12.0", null, "en");
    expect(out).toContain("spectroscope");
    expect(out).toContain("v0.12.0");
    expect(out).not.toContain("about-build");
    expect(out).not.toContain("Test build");
  });

  it("shows the label beside the version on a test build, in English", () => {
    const out = html("0.12.0", LABEL, "en");
    expect(out).toContain("v0.12.0");
    expect(out).toContain("about-build");
    expect(out).toContain("Test build");
    expect(out).toContain(LABEL);
  });

  it("and in German", () => {
    const out = html("0.12.0", LABEL, "de");
    expect(out).toContain("Testbuild");
    expect(out).toContain(LABEL);
  });

  it("keeps the tagline in both cases", () => {
    for (const label of [null, LABEL]) {
      expect(html("0.12.0", label, "en")).toContain("agent orchestrator");
    }
  });

  it("has a German and an English word for the test build line", () => {
    expect(dict["about.testBuild"]?.de).toBe("Testbuild");
    expect(dict["about.testBuild"]?.en).toBe("Test build");
  });
});

describe("the mount in AboutDialog", () => {
  const src = stripComments(read("./AboutDialog.tsx", import.meta.url));

  it("renders the identity line with the label from the server", () => {
    expect(src).toMatch(/<AboutIdentity\s+version=\{version\}\s+label=\{label\}\s+lang=\{lang\}\s*\/>/);
    expect(src).toContain("buildLabel(c?.label)");
    expect(src).toContain("releaseVersion(c?.version)");
  });
});

describe("the window title", () => {
  const indexTitle = /<title>([^<]*)<\/title>/.exec(read("../../index.html", import.meta.url))?.[1];

  it("is the page's own title without a label", () => {
    expect(indexTitle).toBe("spectroscope");
    expect(windowTitle(null)).toBe(indexTitle);
  });

  it("carries the label on a test build", () => {
    expect(windowTitle(LABEL)).toBe(`spectroscope ${LABEL}`);
  });

  it("is set from the server's answer when there is a label", async () => {
    const doc = { title: "spectroscope" };
    await applyBuildTitle(() => Promise.resolve({ version: "0.12.0", label: LABEL }), doc);
    expect(doc.title).toBe(`spectroscope ${LABEL}`);
  });

  it("is left alone on a release, and when the server does not answer", async () => {
    const doc = { title: "spectroscope" };
    await applyBuildTitle(() => Promise.resolve({ version: "0.12.0" }), doc);
    expect(doc.title).toBe("spectroscope");
    await applyBuildTitle(() => Promise.resolve(null), doc);
    expect(doc.title).toBe("spectroscope");
    await applyBuildTitle(() => Promise.reject(new Error("offline")), doc);
    expect(doc.title).toBe("spectroscope");
  });

  it("is applied once at startup", () => {
    const main = stripComments(read("../main.tsx", import.meta.url));
    expect(main).toMatch(/\bvoid applyBuildTitle\(\);/);
  });
});

describe("the desktop shell stays on the plain version (criterion 6)", () => {
  // The window title follows document.title, which the page sets above. The
  // shell itself never reads the label, so app.getVersion() (package.json),
  // the user agent marker and the cache clear on upgrade are untouched.
  const main = stripComments(read("../../../spectro-desktop/src/main.ts", import.meta.url));
  const desktopVersion = (
    JSON.parse(read("../../../spectro-desktop/package.json", import.meta.url)) as { version: string }
  ).version;
  const serverVersion = /^version = "([^"]+)"/m.exec(
    read("../../../spectro-server/build.gradle.kts", import.meta.url),
  )?.[1];

  it("never reads the build label or asks the server for it", () => {
    expect(main).not.toContain("/api/bundles");
    expect(main).not.toMatch(/buildLabel/);
    expect(main).not.toContain("setTitle(");
  });

  it("keys the cache clear and the user agent on app.getVersion()", () => {
    expect(main).toContain("shouldClearCache(readLastRunVersion(raw), app.getVersion())");
    expect(main).toContain("lastRunVersionPayload(app.getVersion())");
    expect(main).toContain("${DESKTOP_MARKER}${app.getVersion()}");
  });

  it("ships the plain release version as the app version", () => {
    expect(desktopVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(desktopVersion).toBe(serverVersion);
  });

  it("keeps the cache on the shipped app version and clears it on the next minor", () => {
    // No label in here: this checks shouldClearCache on the version in
    // spectro-desktop/package.json. That the shell never reads the label and
    // keys the cache on app.getVersion() is pinned by the first two cases of
    // this block.
    const [major, minor] = desktopVersion.split(".").map(Number);
    expect(shouldClearCache(desktopVersion, desktopVersion)).toBe(false);
    expect(shouldClearCache(desktopVersion, `${major}.${minor + 1}.0`)).toBe(true);
  });
});

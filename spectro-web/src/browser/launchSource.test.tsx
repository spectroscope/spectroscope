// Card 350 in the operator's half of the product: WHICH launch file answered.
//
// The card exists to stop two files disagreeing in silence. The server picks
// one whole file and names the ones it passed over; if the start page does not
// print that, the silence is back — the operator edits .claude/launch.json,
// sees no change, and has no way to learn that a .spectro/launch.json beside it
// is the one being read.
//
// Same method as startPage.test.tsx: no DOM, the presentational half rendered
// to markup, assertions on the markup.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartPage } from "./BrowserSegment";
import type { LaunchList } from "./liveView";
import { parseViewMessage } from "./liveView";
import { t } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";

const en = currentLang();

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const listed = (over: Partial<LaunchList> = {}): LaunchList => ({
  ok: true,
  sentence: null,
  skipped: 0,
  location: ".spectro/launch.json",
  shadowed: [],
  configs: [{ name: "web", address: "http://localhost:5173/", attaches: false, up: false, exitCode: null }],
  ...over,
});

const start = (launch: LaunchList | null): string =>
  renderToStaticMarkup(<StartPage launch={launch} playing={null} onPlay={() => {}} />);

describe("the start page names the file it read", () => {
  it("prints the location beside the configurations", () => {
    expect(start(listed())).toContain(esc(".spectro/launch.json"));
  });

  it("prints Claude Code's location just as plainly when that is the one", () => {
    expect(start(listed({ location: ".claude/launch.json" }))).toContain(esc(".claude/launch.json"));
  });

  it("says when a second file was passed over, and names it", () => {
    const markup = start(listed({ shadowed: [".claude/launch.json"] }));
    expect(markup).toContain(esc(t(en, "browser.start.shadowed", { file: ".claude/launch.json" })));
  });

  it("stays quiet about shadowing in the ordinary case of one file", () => {
    expect(start(listed())).not.toContain("browser-start-shadowed");
  });

  it("says nothing about a source when there is no file to name", () => {
    expect(start(listed({ location: null, configs: [] }))).not.toContain("browser-start-source");
  });

  it("says it in German too", () => {
    setLang("de");
    try {
      const markup = start(listed({ shadowed: [".claude/launch.json"] }));
      expect(markup).toContain(esc(t("de", "browser.start.shadowed", { file: ".claude/launch.json" })));
    } finally {
      setLang(en);
    }
  });
});

describe("the wire carries what the server measured", () => {
  const frame = (extra: Record<string, unknown>): LaunchList => {
    const read = parseViewMessage(
      JSON.stringify({
        type: "launch_configs",
        sessionId: "s1",
        ok: true,
        skipped: 0,
        configs: [{ name: "web", address: "http://localhost:5173/", attaches: false, up: false }],
        ...extra,
      }),
    );
    if (read === null || read.kind !== "launchConfigs") throw new Error("not a launch list");
    return read;
  };

  it("reads the location and the shadowed list off the frame", () => {
    const read = frame({
      location: ".spectro/launch.json",
      shadowed: [".claude/launch.json"],
    });
    expect(read.location).toBe(".spectro/launch.json");
    expect(read.shadowed).toEqual([".claude/launch.json"]);
  });

  it("survives a server that sends neither — an older build, or no file at all", () => {
    const read = frame({});
    expect(read.location).toBeNull();
    expect(read.shadowed).toEqual([]);
  });

  it("drops anything in the shadowed array that is not a string", () => {
    const read = frame({ location: 7, shadowed: [".claude/launch.json", 3, null] });
    expect(read.location).toBeNull();
    expect(read.shadowed).toEqual([".claude/launch.json"]);
  });
});

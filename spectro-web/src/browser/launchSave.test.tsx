// Card 352: the operator creates a launch configuration from inside the app.
//
// Card 350 built the writer; card 352 measured that NOTHING called it —
// `grep -rn LaunchWriter --include=*.java` outside tests returned its own
// declaration and one javadoc mention. So "the product can write a launch file"
// was true of the machinery and false of the product.
//
// Three halves are pinned here, and they are different kinds of claim:
//  1. the frame speaks the launch file's OWN field names, so nothing between
//     the form and the file translates a dialect (card 202's rule, out here);
//  2. the draft becomes an entry by one pure function, which is what makes the
//     argument splitting testable at all — this suite renders markup and drives
//     no events, like every other component suite in this folder;
//  3. the form is on the page, labelled, and the server's refusal has somewhere
//     to land.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { launchSaveFrame, parseViewMessage } from "./liveView";
import { entryFromDraft, EMPTY_DRAFT, type LaunchDraft } from "./launchDraft";
import {
  DesktopFaceView,
  StartPage,
  WebFaceView,
  type DesktopFaceViewProps,
  type WebFaceViewProps,
} from "./BrowserSegment";
import type { LaunchList } from "./liveView";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const lang = currentLang();

const EMPTY: LaunchList = {
  ok: true,
  sentence: null,
  skipped: 0,
  location: null,
  shadowed: [],
  configs: [],
};

const draft = (over: Partial<LaunchDraft>): LaunchDraft => ({ ...EMPTY_DRAFT, ...over });

describe("the save frame", () => {
  it("carries the entry in the launch file's own field names", () => {
    expect(
      launchSaveFrame("s1", {
        name: "dev",
        runtimeExecutable: "npm",
        runtimeArgs: ["run", "dev"],
        port: 5173,
        url: null,
      }),
    ).toEqual({
      type: "launch_save",
      sessionId: "s1",
      entry: { name: "dev", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 5173 },
    });
  });

  it("leaves out what the operator did not fill in", () => {
    // An empty string is not a value the writer should have to judge: "" for an
    // executable would make an attach entry look like a broken command entry,
    // and the writer's refusals are written against absent, not blank.
    expect(
      launchSaveFrame("s1", {
        name: "staging",
        runtimeExecutable: null,
        runtimeArgs: [],
        port: null,
        url: "https://staging.example.test/",
      }),
    ).toEqual({
      type: "launch_save",
      sessionId: "s1",
      entry: { name: "staging", runtimeArgs: [], url: "https://staging.example.test/" },
    });
  });

  it("reads the server's answer, refusal and all", () => {
    expect(
      parseViewMessage(JSON.stringify({ type: "launch_saved", ok: true, location: ".spectro/launch.json" })),
    ).toEqual({ kind: "launchSaved", ok: true, location: ".spectro/launch.json", sentence: null });
    expect(parseViewMessage(JSON.stringify({ type: "launch_saved", ok: false, sentence: "no" }))).toEqual({
      kind: "launchSaved",
      ok: false,
      location: null,
      sentence: "no",
    });
  });
});

describe("the draft the operator fills in", () => {
  it("splits arguments a LINE at a time, never on whitespace", () => {
    // `--message hello world` is ONE argument that carries spaces. A splitter
    // on whitespace turns it into three, and the quoting problem
    // LaunchEntry.commandLine() exists to solve is not one a form should
    // re-open. One per line is unambiguous and needs no quoting rules.
    expect(
      entryFromDraft(draft({ name: "dev", command: "npm", args: "run\n--message hello world\n" })),
    ).toEqual({
      name: "dev",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "--message hello world"],
      port: null,
      url: null,
    });
  });

  it("trims what the operator typed and drops blank lines between arguments", () => {
    expect(entryFromDraft(draft({ name: "  dev  ", command: " npm ", args: "run\n\n  dev  \n" }))).toEqual({
      name: "dev",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "dev"],
      port: null,
      url: null,
    });
  });

  it("reads a port as a number and an unreadable one as absent", () => {
    // Absent, not zero. A port of 0 is a claim the writer would judge against
    // its 1–65535 range and refuse with a sentence about a port the operator
    // never typed; absent is what an empty field means.
    expect(entryFromDraft(draft({ name: "dev", port: "5173" })).port).toBe(5173);
    expect(entryFromDraft(draft({ name: "dev", port: "  " })).port).toBeNull();
    expect(entryFromDraft(draft({ name: "dev", port: "eight" })).port).toBeNull();
  });

  it("judges nothing else — the writer owns what may be authored", () => {
    // Deliberately: a second opinion here is the two-hand-lists arrangement
    // this repository has been bitten by. An entry with no name and no address
    // travels, and comes back as the writer's own refusal.
    expect(entryFromDraft(EMPTY_DRAFT)).toEqual({
      name: "",
      runtimeExecutable: null,
      runtimeArgs: [],
      port: null,
      url: null,
    });
  });
});

describe("the form on the start page", () => {
  it("is not there until the operator opens it", () => {
    const shut = renderToStaticMarkup(
      <StartPage launch={EMPTY} playing={null} onPlay={() => {}} onSave={() => {}} />,
    );
    expect(shut).toContain(t(lang, "browser.start.add"));
    expect(shut).not.toContain("browser-start-form");
  });

  it("names every field it asks for", () => {
    const open = renderToStaticMarkup(
      <StartPage launch={EMPTY} playing={null} onPlay={() => {}} onSave={() => {}} formOpen />,
    );
    expect(open).toContain("browser-start-form");
    for (const key of [
      "browser.start.form.name",
      "browser.start.form.command",
      "browser.start.form.args",
      "browser.start.form.port",
      "browser.start.form.url",
    ] as const) {
      expect(open, `${key} is not on the form`).toContain(t(lang, key));
    }
  });

  it("shows the server's refusal where the operator typed", () => {
    // The writer's guards are the only validation, so its sentence has to reach
    // the operator. A refusal that only logs is a silent no-op with a spinner.
    const shown = renderToStaticMarkup(
      <StartPage
        launch={EMPTY}
        playing={null}
        onPlay={() => {}}
        onSave={() => {}}
        formOpen
        saveNotice="two launch configurations are both called dev"
      />,
    );
    expect(shown).toContain("two launch configurations are both called dev");
  });

  it("says nothing about a save that has not happened", () => {
    const quiet = renderToStaticMarkup(
      <StartPage launch={EMPTY} playing={null} onPlay={() => {}} onSave={() => {}} formOpen />,
    );
    expect(quiet).not.toContain("browser-start-savenotice");
  });
});

describe("the form reaches the operator on BOTH faces", () => {
  // The defect card 345 was cut for, one card later: StartPage is the only
  // place in the product that lists launch configurations, and it is mounted
  // four times — twice per face, once in the hole and once inside the launch
  // menu. A face that simply did not pass `onSave` would render the list it
  // always rendered, with no form and nothing red anywhere. So the reach is
  // measured per face rather than assumed from the component's own test.
  const web: WebFaceViewProps = {
    sessionId: "s1",
    mode: "web",
    url: null,
    draft: null,
    picture: null,
    notice: null,
    launch: EMPTY,
    playing: null,
    canGoBack: null,
    canGoForward: null,
    allowLocalhost: false,
    send: () => {},
    onDraft: () => {},
    onPlay: () => {},
    onSave: () => {},
  };
  const desktop: DesktopFaceViewProps = {
    state: "attached",
    floored: false,
    sessionId: "s1",
    url: null,
    draft: null,
    notice: null,
    launch: EMPTY,
    playing: null,
    canGoBack: null,
    canGoForward: null,
    allowLocalhost: false,
    send: () => {},
    onDraft: () => {},
    onPlay: () => {},
    onSave: () => {},
    onShot: () => {},
  };

  it("offers it on the web face", () => {
    expect(renderToStaticMarkup(<WebFaceView {...web} />)).toContain(t(lang, "browser.start.add"));
  });

  it("offers it on the desktop face", () => {
    expect(renderToStaticMarkup(<DesktopFaceView {...desktop} />)).toContain(t(lang, "browser.start.add"));
  });

  it("and a page that was never given a pen shows no form at all", () => {
    // The prop is optional the whole way down, so a caller that has no server
    // to write through gets exactly the page card 227 shipped.
    const noPen = renderToStaticMarkup(<StartPage launch={EMPTY} playing={null} onPlay={() => {}} />);
    expect(noPen).not.toContain(t(lang, "browser.start.add"));
    expect(noPen).toContain(t(lang, "browser.start.heading"));
  });
});

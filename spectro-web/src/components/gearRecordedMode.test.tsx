// Card 504, last fix round: the gear of a stored session marks the mode the
// session runs with when continued (state/recordedMode.ts), not the "ask" an
// empty fold defaults to; a live session keeps the wire's mode.

import { describe, expect, it, vi } from "vitest";
import { ComposerGear } from "./ComposerGear";
import { t } from "../i18n/i18n";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { sentWrites } from "../state/sentWrites";

vi.mock("../state/serverSettings", async (original) => ({
  ...(await original<typeof import("../state/serverSettings")>()),
  fetchSettings: () => new Promise(() => {}),
}));

const openGear: Step = (tree: El[]) => {
  const gear = tree.find(
    (el) =>
      el.type === "button" &&
      el.props["aria-haspopup"] === "dialog" &&
      el.props.title === t("en", "wsg.title"),
  );
  if (gear === undefined) throw new Error("the gear is not in this pass");
  gear.props.onClick?.();
};

function marked(recordedMode: string | null | undefined): string[] {
  let selected: string[] = [];
  const look: Step = (tree: El[]) => {
    const rows = tree.filter((el) => el.type === "div" && el.props.role === "option");
    expect(rows.length, "positive: the four permission modes are drawn").toBe(4);
    selected = rows.filter((el) => el.props["aria-selected"] === true).map((el) => String(el.key));
  };
  drive(
    <ComposerGear
      workspaceInfo={null}
      permissionMode="ask"
      recordedMode={recordedMode}
      toolGroups={null}
      localMode={null}
      sendClient={() => true}
    />,
    [ComposerGear],
    [openGear, look],
  );
  return selected;
}

describe("the gear of a stored session", () => {
  it("marks the recorded mode", () => {
    expect(marked("auto")).toEqual(["auto"]);
  });

  it("marks the wire's mode when nothing is recorded", () => {
    expect(marked(null)).toEqual(["ask"]);
    expect(marked(undefined)).toEqual(["ask"]);
  });
});

// Last fix round 2026-10-12: a choice the session took shows at once, before
// the session turns live.
function chosenAfterClick(sent: boolean): string[] {
  const chosen: string[] = [];
  const press: Step = (tree: El[]) => {
    const row = tree.find((el) => el.type === "div" && el.props.role === "option" && el.key === "readonly");
    if (row === undefined) throw new Error("the readonly row is not in this pass");
    row.props.onClick?.();
  };
  drive(
    <ComposerGear
      workspaceInfo={null}
      permissionMode="ask"
      recordedMode="auto"
      onModeChosen={(mode) => chosen.push(mode)}
      toolGroups={null}
      localMode={null}
      sendClient={() => sent}
    />,
    [ComposerGear],
    [openGear, press],
  );
  return chosen;
}

describe("a mode chosen in the gear of a stored session", () => {
  it("is reported once the frame was taken", () => {
    expect(chosenAfterClick(true)).toEqual(["readonly"]);
  });

  it("is not reported when the frame did not leave", () => {
    expect(chosenAfterClick(false)).toEqual([]);
  });
});

describe("the wiring", () => {
  const chat = stripComments(read("./Chat.tsx", import.meta.url));
  const app = stripComments(read("../App.tsx", import.meta.url));
  const lab = stripComments(read("../lab/LabView.tsx", import.meta.url));

  it("Chat reads the recorded mode of its stored session and hands it to the gear", () => {
    expect(chat).toMatch(
      /const \[recordedMode, chooseRecordedMode\] = useRecordedMode\(\s*props\.liveView \? null : \(props\.storedSessionId \?\? null\),?\s*\)/,
    );
    expect(chat).toMatch(/recordedMode=\{recordedMode\}/);
    expect(chat).toMatch(/onModeChosen=\{chooseRecordedMode\}/);
  });

  it("App names the stored session in the main chat and in the Lab", () => {
    expect(app).toMatch(/storedSessionId: canResume \? replay!\.id : null/);
    expect(app).toMatch(/storedSessionId=\{canResume \? replay!\.id : null\}/);
    expect(lab).toMatch(/storedSessionId=\{props\.storedSessionId\}/);
  });
});

// Card 504, final round of 2026-10-12: on a stored session the gear's answer
// is true once the frame joined a resume, and a failed resume drops the frame.
// The mark waits for the frame to reach a socket (state/sentWrites.ts).
function chosenOnStored(after: (frame: { type: "set_permission_mode"; mode: string }) => void): string[] {
  const chosen: string[] = [];
  const press: Step = (tree: El[]) => {
    const row = tree.find((el) => el.type === "div" && el.props.role === "option" && el.key === "readonly");
    if (row === undefined) throw new Error("the readonly row is not in this pass");
    row.props.onClick?.();
  };
  drive(
    <ComposerGear
      workspaceInfo={null}
      permissionMode="ask"
      recordedMode="auto"
      storedSessionId="20261012-101010-gear"
      onModeChosen={(mode) => chosen.push(mode)}
      toolGroups={null}
      localMode={null}
      sendClient={() => true}
    />,
    [ComposerGear],
    [openGear, press],
  );
  expect(chosen, "the frame only joined a resume: nothing is marked yet").toEqual([]);
  after({ type: "set_permission_mode", mode: "readonly" });
  return chosen;
}

describe("a mode chosen on a stored session whose frame joined a resume", () => {
  it("is marked when the frame reaches the session's socket", () => {
    expect(chosenOnStored((frame) => sentWrites.sent("20261012-101010-gear", frame))).toEqual(["readonly"]);
  });

  it("is never marked when the resume fails and drops the frame", () => {
    expect(
      chosenOnStored((frame) => {
        sentWrites.drop("20261012-101010-gear", frame);
        sentWrites.sent("20261012-101010-gear", frame);
      }),
    ).toEqual([]);
  });
});

// Card 504, hub and spoke review round 2: the gear writes the permission mode
// into the project file only when the frame left. A stored session that cannot
// be continued answers false, and a file that then says "auto" while the
// session runs "ask" would be two truths.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerGear } from "./ComposerGear";
import type { ClientMessage } from "../events";
import { t } from "../i18n/i18n";
import type { WorkspaceInfo } from "../state/reducer";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { sentWrites } from "../state/sentWrites";

const putSettings = vi.fn((..._args: unknown[]) => new Promise(() => {}));
vi.mock("../state/serverSettings", async (original) => ({
  ...(await original<typeof import("../state/serverSettings")>()),
  putSettings: (...args: unknown[]) => putSettings(...args),
  fetchSettings: () => new Promise(() => {}),
}));

const PINNED = {
  sessionId: "20261012-090000-abcd",
  path: "/tmp/project",
  configured: true,
  resolved: true,
  mode: "configured",
} as unknown as WorkspaceInfo;

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
const chooseAuto: Step = (tree: El[]) => {
  const modes = tree.filter((el) => el.type === "div" && el.props.role === "option");
  expect(modes.length, "positive: the four permission modes are drawn").toBe(4);
  modes[1]?.props.onClick?.();
};

/**
 * @param answer what sendSession answers
 * @param wire whether the frame then reaches a socket (App's onSent); a
 *             stored session answers true when the frame joined its resume,
 *             and a failed events fetch drops the frame before the wire
 */
function press(answer: boolean, wire = answer): ClientMessage[] {
  const frames: ClientMessage[] = [];
  drive(
    <ComposerGear
      workspaceInfo={PINNED}
      permissionMode="ask"
      toolGroups={null}
      localMode={null}
      sendClient={() => true}
      sendSession={(frame) => {
        frames.push(frame);
        if (wire) sentWrites.sent(PINNED.sessionId ?? null, frame);
        return answer;
      }}
    />,
    [ComposerGear],
    [openGear, chooseAuto],
  );
  return frames;
}

describe("the gear's permission mode and the project file", () => {
  beforeEach(() => {
    putSettings.mockClear();
  });

  it("writes the file when the frame left", () => {
    expect(press(true)).toEqual([{ type: "set_permission_mode", mode: "auto" }]);
    expect(putSettings).toHaveBeenCalledTimes(1);
    expect(putSettings).toHaveBeenCalledWith("project", { permissionMode: "auto" }, "20261012-090000-abcd");
  });

  // Last fix round: on a stored session sessionFrame answers true once the
  // frame joined or started a resume, and a failed events fetch then drops
  // the frame. The file follows the wire, not the answer.
  it("leaves the file alone when the frame joined a resume whose fetch failed", () => {
    expect(press(true, false), "positive: the gear did try to send").toEqual([
      { type: "set_permission_mode", mode: "auto" },
    ]);
    expect(putSettings).not.toHaveBeenCalled();
    sentWrites.sent("another-session", { type: "set_permission_mode", mode: "auto" });
    expect(putSettings, "a frame of another session writes nothing").not.toHaveBeenCalled();
    sentWrites.sent(PINNED.sessionId ?? null, { type: "set_permission_mode", mode: "auto" });
    expect(
      putSettings,
      "the frame that does reach the wire later writes the file once",
    ).toHaveBeenCalledTimes(1);
  });

  it("leaves the file alone when the frame did not leave", () => {
    expect(press(false), "positive: the gear did try to send").toEqual([
      { type: "set_permission_mode", mode: "auto" },
    ]);
    expect(putSettings).not.toHaveBeenCalled();
  });
});

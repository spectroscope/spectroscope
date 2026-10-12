// Card 504, hub and spoke review, round 1: every frame the composer gear sends
// belongs to the session on screen, so it leaves through sendSession (Chat's
// onSessionFrame), which continues a stored session first. sendClient reaches
// the socket in view, which on a reopened stored session is another session's.
//
// chatComposerCommand.test.tsx presses each control the gear has today. This
// pins the source, so a control added later that calls sendClient turns red
// here: the only use of sendClient left in the gear is the fallback for a
// host without a session frame.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const gear = stripComments(read("./ComposerGear.tsx", import.meta.url));

/** The places sendClient may appear: its prop, its type, the one fallback, and
 *  the key of switchToolGroups' deps, which is handed sendFrame. */
const ALLOWED = [
  /\bsendClient,\n/,
  /\bsendClient: \(msg: ClientMessage\) => boolean;/,
  /const sendFrame = sendSession \?\? sendClient;/,
  /switchToolGroups\(off, \{ sendClient: sendFrame, save: savesHere \}\);/,
];

/** The source with the allowed uses blanked, so what is left is a send on the socket in view. */
function strayUses(source: string): string[] {
  let rest = source;
  // Blanked, not cut, so the line numbers in a failure stay the file's own.
  for (const allowed of ALLOWED) rest = rest.replace(allowed, (hit) => hit.replace(/[^\n]/g, " "));
  return rest
    .split("\n")
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => /\bsendClient\b/.test(line))
    .map(({ line, at }) => `${at}: ${line.trim()}`);
}

describe("the composer gear's frames", () => {
  it("each allowed use of sendClient is there, once", () => {
    for (const allowed of ALLOWED) {
      expect(gear.match(new RegExp(allowed.source, "g")) ?? [], String(allowed)).toHaveLength(1);
    }
  });

  it("no frame leaves the gear on sendClient", () => {
    expect(strayUses(gear), "a gear frame on the socket in view").toEqual([]);
  });

  it("the scan finds a stray send", () => {
    const planted = `${gear}\nconst later = (): void => {\n  sendClient({ type: "set_permission_mode", mode: "auto" });\n};\n`;
    expect(strayUses(planted)).toHaveLength(1);
  });

  it("the goal, the modes, the tool groups and Local mode all use sendFrame", () => {
    expect(gear).toContain("<GoalSection lang={lang} goal={goal} sendSession={sendFrame} />");
    // Last fix round: the mode frame is built once, held for the file write,
    // and sent on sendFrame.
    expect(gear).toMatch(
      /const frame: ClientMessage = \{ type: "set_permission_mode", mode \};[\s\S]{0,600}if \(!sendFrame\(frame\)\) \{\s*if \(persists\) sentWrites\.drop\(sessionId, frame\);/,
    );
    expect(gear).toContain("switchToolGroups(off, { sendClient: sendFrame, save: savesHere });");
    expect(gear).toContain("onSwitch={(on) => switchLocalMode(on, sendFrame)}");
    expect(gear).toContain("onEdit={(key, value) => editLocalModeValue(key, value, sendFrame)}");
    expect(gear).toContain("onReset={(key) => resetLocalModeValue(key, sendFrame)}");
  });
});

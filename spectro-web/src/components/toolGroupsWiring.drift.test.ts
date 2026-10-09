// Card 466, criterion 3: the section is mounted in the composer gear, fed the
// server's last tool_groups_info, and a change goes over the socket frame,
// which also asks the server to save into the LOCAL scope of a pinned folder.
// state/toolGroups.test.ts pins what switchToolGroups and savesToolGroups do;
// this pins that the gear is the one calling them, with the workspace frame
// as it arrived and not only once a run resolved it.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const gear = stripComments(read("./ComposerGear.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));

const contextTab = stripComments(read("./SystemContextTab.tsx", import.meta.url));
const rightPanel = stripComments(read("./RightPanel.tsx", import.meta.url));
const app = stripComments(read("../App.tsx", import.meta.url));

describe("the tool groups in the composer gear", () => {
  it("are drawn from the server's frame and report to the switch", () => {
    expect(gear).toContain("info={toolGroups}");
    expect(gear).toContain("onChange={chooseToolGroups}");
    expect(gear).toContain("saved={savesHere}");
    expect(chat).toContain("toolGroups={state.toolGroups}");
  });

  it("save as soon as the workspace frame names a pinned folder, resolved or not", () => {
    expect(gear).toContain("const savesHere = savesToolGroups(workspaceInfo);");
  });

  it("ask the server to save, and never write a scope over REST themselves", () => {
    const body = gear.slice(gear.indexOf("const chooseToolGroups"), gear.indexOf("const onListKeyDown"));
    expect(body).toContain("switchToolGroups(off, { sendClient, save: savesHere })");
    expect(body).not.toContain("putSettings(");
  });
});

describe("the System context tab", () => {
  it("leaves out the tools of the switched-off groups, from the live frame", () => {
    expect(contextTab).toContain("withoutSwitchedOff(fetched.tools, toolGroups)");
    expect(rightPanel).toContain("toolGroups={toolGroups}");
    expect(app).toContain("toolGroups={view.toolGroups}");
  });
});

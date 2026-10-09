// Card 466: the composer gear's tool groups, the pure half. The server says
// which groups exist and what each one holds (tool_groups_info); this module
// reads that frame defensively and computes the list the gear sends back.

import { describe, expect, it } from "vitest";
import {
  groupHint,
  parseToolGroupsInfo,
  savesToolGroups,
  switchToolGroups,
  toggleGroup,
  withoutSwitchedOff,
} from "./toolGroups";
import type { WorkspaceInfo } from "./reducer";

const frame = {
  type: "tool_groups_info",
  off: ["launch"],
  groups: [
    { name: "browser", tools: ["browser_click", "browser_read_page"] },
    { name: "launch", tools: ["launch_list"] },
    { name: "mcp", tools: [] },
  ],
};

describe("parseToolGroupsInfo", () => {
  it("reads the groups in the server's order with their tools and the switched-off list", () => {
    expect(parseToolGroupsInfo(frame)).toEqual({
      off: ["launch"],
      groups: [
        { name: "browser", tools: ["browser_click", "browser_read_page"] },
        { name: "launch", tools: ["launch_list"] },
        { name: "mcp", tools: [] },
      ],
    });
  });

  it("refuses a frame that is not one, rather than drawing an empty gear from it", () => {
    expect(parseToolGroupsInfo(null)).toBeNull();
    expect(parseToolGroupsInfo({ type: "tool_groups_info" })).toBeNull();
    expect(parseToolGroupsInfo({ type: "tool_groups_info", off: "browser", groups: [] })).toBeNull();
  });

  it("drops entries of the wrong shape and keeps the rest", () => {
    expect(
      parseToolGroupsInfo({
        type: "tool_groups_info",
        off: ["browser", 7],
        groups: [{ name: "browser", tools: ["browser_click", 3] }, { tools: [] }, "web"],
      }),
    ).toEqual({ off: ["browser"], groups: [{ name: "browser", tools: ["browser_click"] }] });
  });
});

describe("toggleGroup", () => {
  const order = ["browser", "launch", "images", "web", "agents", "roles", "mcp"];

  it("switches a group off and keeps the list in the server's order", () => {
    expect(toggleGroup(["mcp"], "browser", order)).toEqual(["browser", "mcp"]);
  });

  it("switches a group back on", () => {
    expect(toggleGroup(["browser", "mcp"], "browser", order)).toEqual(["mcp"]);
  });

  it("never sends a name twice or a name the server did not list", () => {
    expect(toggleGroup(["browser", "browser"], "launch", order)).toEqual(["browser", "launch"]);
    expect(toggleGroup(["printer"], "web", order)).toEqual(["web"]);
  });
});

describe("groupHint", () => {
  it("names the tools of the group", () => {
    expect(groupHint({ name: "browser", tools: ["browser_click", "browser_read_page"] })).toBe(
      "browser_click, browser_read_page",
    );
  });

  it("says nothing for a group the session does not carry", () => {
    expect(groupHint({ name: "mcp", tools: [] })).toBe("");
  });
});

describe("switchToolGroups", () => {
  it("sends the list and asks the server to save it when the session has a pinned folder", () => {
    const sent: unknown[] = [];
    switchToolGroups(["browser", "launch"], {
      sendClient: (msg) => {
        sent.push(msg);
        return true;
      },
      save: true,
    });
    expect(sent).toEqual([{ type: "set_tool_groups_off", groups: ["browser", "launch"], save: true }]);
  });

  it("still switches the open session when there is no folder to save into", () => {
    const sent: unknown[] = [];
    switchToolGroups([], { sendClient: (msg) => sent.push(msg) > 0, save: false });
    expect(sent).toEqual([{ type: "set_tool_groups_off", groups: [], save: false }]);
  });
});

describe("savesToolGroups", () => {
  const prospective: WorkspaceInfo = {
    configured: true,
    resolved: false,
    mode: "default",
    path: "/tmp/demo",
    exists: true,
  };

  it("saves from the moment the connection's workspace frame names a pinned folder", () => {
    expect(savesToolGroups(prospective)).toBe(true);
  });

  it("keeps saving once a run has resolved the folder", () => {
    expect(savesToolGroups({ ...prospective, resolved: true, sessionId: "s-1" })).toBe(true);
  });

  it("does not save without a pinned folder or before any workspace frame", () => {
    expect(savesToolGroups({ ...prospective, configured: false, mode: "random", path: undefined })).toBe(
      false,
    );
    expect(savesToolGroups(null)).toBe(false);
  });
});

describe("the save error", () => {
  it("is read from the frame when the server could not save", () => {
    expect(parseToolGroupsInfo({ ...frame, saveError: "the folder does not exist yet" })?.saveError).toBe(
      "the folder does not exist yet",
    );
  });

  it("is absent when the server saved or was not asked to", () => {
    expect(parseToolGroupsInfo(frame)?.saveError).toBeUndefined();
    expect(parseToolGroupsInfo({ ...frame, saveError: 7 })?.saveError).toBeUndefined();
  });
});

describe("withoutSwitchedOff", () => {
  const info = parseToolGroupsInfo(frame);

  it("drops the tools the server lists under a switched-off group and keeps the order", () => {
    const tools = [{ name: "read_file" }, { name: "launch_list" }, { name: "browser_click" }];
    expect(withoutSwitchedOff(tools, info).map((tool) => tool.name)).toEqual(["read_file", "browser_click"]);
  });

  it("keeps every tool before the server has said anything", () => {
    const tools = [{ name: "launch_list" }];
    expect(withoutSwitchedOff(tools, null)).toEqual(tools);
  });
});

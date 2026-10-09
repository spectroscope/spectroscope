// Card 498: the chip of a stored session after its wake. The wake answers with
// the session id, so Finder, Terminal and the code graph can act on a folder
// that is there, and a recorded folder that is gone says so in the chip with
// the wording the failed Finder call already used.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceInfo } from "../state/reducer";
import { WorkspaceChip, chipActions, codeGraphRowEnabled } from "./WorkspaceChip";
import { storedChipWorkspace } from "../workspace/wakeChip";

const WOKEN: WorkspaceInfo = {
  sessionId: "20261009-210000-w498",
  path: "/Users/someone/ForgeDemo",
  configured: false,
  resolved: true,
  mode: "recorded",
  exists: true,
};
const GONE: WorkspaceInfo = {
  sessionId: "20261009-210000-w498",
  path: "/Users/someone/deleted-project",
  configured: false,
  resolved: false,
  mode: "recorded",
  exists: false,
  unavailable: "/Users/someone/deleted-project",
};
const STORED = storedChipWorkspace("/Users/someone/ForgeDemo")!;
const LOCKED_MAC = { canPick: false, mac: true };
const enabled = (ws: WorkspaceInfo) =>
  chipActions(ws, LOCKED_MAC)
    .filter((a) => a.enabled)
    .map((a) => a.id);

describe("a stored session's chip", () => {
  it("before the wake names the folder and lets only the path be copied", () => {
    expect(enabled(STORED)).toEqual(["copy"]);
    expect(codeGraphRowEnabled(STORED)).toBe(false);
  });

  it("after the wake opens Finder, Terminal and the code graph", () => {
    expect(enabled(WOKEN)).toEqual(["reveal", "copy", "terminal"]);
    expect(codeGraphRowEnabled(WOKEN)).toBe(true);
  });

  it("for a folder that is gone keeps Finder, Terminal and the code graph shut, in the not-found words", () => {
    expect(enabled(GONE)).toEqual(["copy"]);
    const reveal = chipActions(GONE, LOCKED_MAC).find((a) => a.id === "reveal");
    const terminal = chipActions(GONE, LOCKED_MAC).find((a) => a.id === "terminal");
    expect(reveal?.reason).toBe("wchip.notFound");
    expect(terminal?.reason).toBe("wchip.notFound");
    expect(codeGraphRowEnabled(GONE)).toBe(false);
  });

  it("says the folder is gone on the chip itself and in its menu", () => {
    const closed = renderToStaticMarkup(
      <WorkspaceChip workspace={GONE} onPickFolder={() => {}} canPick={false} />,
    );
    expect(closed).toContain("deleted-project");
    expect(closed).toContain("The session has no folder on disk");
    const open = renderToStaticMarkup(
      <WorkspaceChip workspace={GONE} onPickFolder={() => {}} canPick={false} mac menuOpenForTest />,
    );
    expect(open).toContain("The session has no folder on disk");
    expect(open).not.toContain("Available after the first message");
  });

  it("does not call a folder that is there gone", () => {
    const open = renderToStaticMarkup(
      <WorkspaceChip workspace={WOKEN} onPickFolder={() => {}} canPick={false} mac menuOpenForTest />,
    );
    expect(open).not.toContain("The session has no folder on disk");
    expect(open).toContain("ForgeDemo");
  });
});

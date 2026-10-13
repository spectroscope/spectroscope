// Card 482, fix round: the playbook pane showed the run view of a stored
// session even when no playbook was pinned to a workspace there (measured
// 2026-10-10, kanban/evidence/482, run6-child-reload.json).
//
// Card 586: the run view left the Playbook segment for the run panel beside the
// chat. The segment keeps one line, "Runs of this session: open", that goes
// back to the chat and shows the session's runs in the wide view.

import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripComments } from "../testkit/source";
import { drive } from "../testkit/driveComponent";
import { __resetPlaybooks } from "../state/playbooks";
import { __getState, __resetForTests, setDockTabs } from "../state/layout";
import { t } from "../i18n/i18n";
import { PlaybookPane } from "./PlaybookPane";

beforeEach(() => {
  __resetPlaybooks();
  __resetForTests();
  setDockTabs(false);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

const LINK = t("en", "pb.run.segmentLink");

describe("the Playbook segment links to the session's runs (card 586)", () => {
  it("draws no run view, and the link for a session, also a stored one with no playbook loaded", () => {
    const out = renderToStaticMarkup(
      <PlaybookPane workspace={null} sessionId="20261010-113710-959cacce" hasRun />,
    );
    expect(out).not.toContain("pb-run-view");
    expect(out).toContain('class="pb-run-link"');
    expect(out).toContain(LINK);
  });

  // Final fix round: the link leads to a run, so a session without one has none.
  it("draws no link for a session without a run", () => {
    const out = renderToStaticMarkup(<PlaybookPane workspace={null} sessionId="s1" hasRun={false} />);
    expect(out).not.toContain("pb-run-link");
    expect(renderToStaticMarkup(<PlaybookPane workspace={null} sessionId="s1" />)).not.toContain(
      "pb-run-link",
    );
  });

  it("draws no link without a session", () => {
    const out = renderToStaticMarkup(<PlaybookPane workspace={null} sessionId={null} />);
    expect(out).not.toContain("pb-run-link");
    expect(out).not.toContain("pb-run-view");
  });

  it("a press shows the chat, turns the run wide and opens the dock on the plan panel", () => {
    let shown = 0;
    expect(__getState().runWide, "premise: not wide").toBe(false);
    expect(__getState().rightPanelOpen, "premise: the dock is closed").toBe(false);
    drive(
      <PlaybookPane workspace={null} sessionId="s1" hasRun onShowChat={() => shown++} />,
      [PlaybookPane],
      [
        (tree) => {
          const link = tree.find((el) => el.type === "button" && el.props.children === LINK);
          expect(link, "the link is drawn").toBeDefined();
          link?.props.onClick?.();
        },
      ],
    );
    expect(shown).toBe(1);
    expect(__getState().runWide).toBe(true);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
  });

  it("App hands the pane its way back to the chat, and the session it shows", () => {
    const app = stripComments(readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8"));
    const pane = /<PlaybookPane([\s\S]*?)\/>/.exec(app)?.[1] ?? "";
    expect(pane, "App renders the PlaybookPane").not.toBe("");
    expect(pane).toMatch(/sessionId=\{playbookSessionId\(/);
    expect(pane).toMatch(/onShowChat=\{showChat\}/);
    expect(pane).toMatch(/hasRun=\{view\.runs\.length > 0\}/);
    const showChat = /const showChat = \(\): void => \{([\s\S]*?)\n {2}\};/.exec(app)?.[1] ?? "";
    expect(showChat).toContain('pickSegment("sessions")');
    expect(showChat).toContain('setTab("chat")');
  });

  it("the run view is gone from the tree", () => {
    const pane = readFileSync(fileURLToPath(new URL("./PlaybookPane.tsx", import.meta.url)), "utf8");
    expect(pane).not.toContain("PlaybookRunView");
  });
});

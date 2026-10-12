// Card 504: the goal line and the loop chip under the composer (card 268),
// and the goal section of the gear. Server renderer, no DOM: Stop's own
// handler is reached by calling the hook-free strip and walking its tree.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientMessage, RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { initialState, reduceAll } from "../state/reducer";
import { parseLoopInfo, type GoalInfo, type LoopInfo } from "../state/goalLoop";
import { ComposerStrip } from "./ComposerStrip";
import { GoalSection } from "./GoalSection";
import { Chat } from "./Chat";

const GOAL: GoalInfo = {
  stated: true,
  outcome: "the tests are green",
  check: "npm test",
  file: "/h/.spectro/goals/s.goal.md",
};
const LOOP = parseLoopInfo({
  active: true,
  loopId: "ab12cd34",
  pacing: "self",
  prompt: "watch the build",
  intervalSeconds: null,
  nextAt: new Date(2026, 9, 11, 10, 42).getTime(),
  reason: "the build takes two minutes",
  keepalive: false,
  held: false,
  fires: 1,
  startedAt: 1,
  endedReason: null,
  maxTurns: 150,
}) as LoopInfo;

function strip(over: Partial<Parameters<typeof ComposerStrip>[0]>, lang: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <ComposerStrip
      lang={lang}
      goal={null}
      verdict={null}
      loop={null}
      runTurn={null}
      sendClient={() => true}
      {...over}
    />,
  );
}

function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => elements(child, out));
  } else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

describe("the strip under the composer", () => {
  it("takes no room without a goal and without a loop", () => {
    expect(strip({})).toBe("");
    expect(strip({ goal: { ...GOAL, stated: false } })).toBe("");
    expect(strip({ loop: { ...LOOP, active: false, endedReason: "user_abort" } })).toBe("");
  });

  it("pins the goal with its last verdict, in both languages", () => {
    const en = strip({ goal: GOAL, verdict: { outcome: "unmet", evidence: "exit 1" } });
    expect(en).toContain("the tests are green");
    expect(en).toContain(t("en", "goal.verdict.unmet"));
    const de = strip({ goal: GOAL, verdict: { outcome: "met", evidence: "exit 0" } }, "de");
    expect(de).toContain(t("de", "goal.verdict.met"));
    expect(de).toContain(t("de", "goal.line"));
  });

  it("names a failed and an untested check on the goal line", () => {
    expect(strip({ goal: GOAL, verdict: { outcome: "failed", evidence: "exit 1" } })).toContain(
      t("en", "goal.verdict.unmet"),
    );
    expect(strip({ goal: GOAL, verdict: { outcome: "untested", evidence: "" } })).toContain(
      t("en", "goal.verdict.untested"),
    );
  });

  it("shows the turn of the live run, the next wakeup, its reason and Stop", () => {
    const en = strip({ loop: LOOP, runTurn: 7 });
    expect(en).toContain(t("en", "loop.chip.turn", { n: 7, of: 150 }));
    expect(en).toContain(t("en", "loop.chip.next", { at: "10:42" }));
    expect(en).toContain("the build takes two minutes");
    expect(en).toContain(t("en", "loop.chip.stop"));
    const de = strip({ loop: LOOP, runTurn: 7 }, "de");
    expect(de).toContain(t("de", "loop.chip.turn", { n: 7, of: 150 }));
  });

  it("Stop sends set_loop stop", () => {
    const sent: ClientMessage[] = [];
    const tree = ComposerStrip({
      lang: "en",
      goal: null,
      verdict: null,
      loop: LOOP,
      runTurn: null,
      sendClient: (m) => (sent.push(m), true),
    });
    const stop = elements(tree).find(
      (el) => (el.props as { className?: string }).className === "loop-chip-stop",
    );
    expect(stop).toBeDefined();
    (stop?.props as { onClick: () => void }).onClick();
    expect(sent).toEqual([{ type: "set_loop", action: "stop" }]);
  });

  it("is drawn by the composer, in the chat light mode loads", async () => {
    const viewMode = await import("../state/viewMode");
    const store = new Map<string, string>();
    viewMode.__setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
    viewMode.setViewMode("light");
    const state = reduceAll(initialState, [
      {
        type: "goal_info",
        stated: true,
        outcome: "the tests are green",
        check: "npm test",
        file: "/g",
        ts: 1,
      },
      { type: "loop_info", ...LOOP, ts: 2 },
    ] as unknown as RunEvent[]);
    const out = renderToStaticMarkup(
      <Chat
        state={state}
        liveView={true}
        onSend={() => {}}
        onReturnToLive={() => {}}
        sendClient={() => true}
      />,
    );
    expect(viewMode.currentViewMode()).toBe("light");
    expect(out).toContain('class="composer-strip"');
    expect(out).toContain("the tests are green");
    expect(out).toContain("the build takes two minutes");
    const chunks = readFileSync(new URL("../state/surfaceChunks.ts", import.meta.url), "utf8");
    expect(chunks).not.toContain("ComposerStrip");
  });
});

afterEach(async () => {
  const viewMode = await import("../state/viewMode");
  viewMode.setViewMode("learn");
});

describe("the goal section of the gear", () => {
  it("offers the outcome, the check command, Set and Clear", () => {
    const html = renderToStaticMarkup(<GoalSection lang="en" goal={null} sendSession={() => true} />);
    expect(html).toContain(t("en", "goal.title"));
    expect(html).toContain(t("en", "goal.outcome"));
    expect(html).toContain(t("en", "goal.check"));
    expect(html).toContain(t("en", "goal.set"));
    expect(html).toContain(t("en", "goal.clear"));
    expect(html).toContain(t("en", "goal.none"));
  });

  it("shows the goal in force and where its file lives, in German too", () => {
    const html = renderToStaticMarkup(<GoalSection lang="de" goal={GOAL} sendSession={() => true} />);
    expect(html).toContain('value="the tests are green"');
    expect(html).toContain('value="npm test"');
    expect(html).toContain(t("de", "goal.stated"));
    expect(html).toContain(GOAL.file);
  });

  it("is a section of the composer gear", () => {
    const gear = readFileSync(new URL("./ComposerGear.tsx", import.meta.url), "utf8");
    // Hub and spoke fix round: the goal leaves on the session's own frame path
    // (review round 1: sendFrame, the gear's one path for every frame).
    expect(gear).toContain("<GoalSection lang={lang} goal={goal} sendSession={sendFrame} />");
    const chat = readFileSync(new URL("./Chat.tsx", import.meta.url), "utf8");
    expect(chat).toContain("goal={state.goal}");
  });
});

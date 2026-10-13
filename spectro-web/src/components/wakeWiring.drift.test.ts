// Card 498: the wake's wiring in App, which no unit test reaches.
//
// The pure parts (wakeChip.ts, the session set's wake record, the chip's gone
// state) are pinned on their own. What stays is the seam: the message box
// reports its focus, App turns that focus into a wake of the stored session on
// screen, the header reads the chip through headerWorkspace, and the first
// message continues on the woken socket instead of opening a second one that
// the server would refuse.
//
// Card 520 moved the wake to the selection: an effect keyed on the replay on
// screen runs the same path when a stored session lands, the focus still runs
// it too, and a held chat is looked up without the woken records.

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every shipped .tsx file under src, by its path from src, comments blanked. */
function sources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!rel.endsWith(".tsx") || rel.includes(".test.") || rel.includes("node_modules")) continue;
    out.set(rel.split("\\").join("/"), stripComments(readFileSync(SRC + rel, "utf8")));
  }
  return out;
}

type Mount = { file: string; line: number; head: string };

/** Every JSX mount of a component: the opening tag up to its first self close. */
function mountsOf(name: string): Mount[] {
  const found: Mount[] = [];
  const tag = new RegExp(`<${name}\\b`, "g");
  for (const [file, text] of sources()) {
    for (const match of text.matchAll(tag)) {
      const at = match.index ?? 0;
      const end = text.indexOf("/>", at);
      found.push({
        file,
        line: text.slice(0, at).split("\n").length,
        head: text.slice(at, end < 0 ? text.length : end),
      });
    }
  }
  return found;
}

/** The mounts of Chat and of ChatV2, the reading that wraps it. */
function chatMounts(): Mount[] {
  return [...mountsOf("Chat"), ...mountsOf("ChatV2")];
}

/** The one value a mount may give onSessionFrame by name: App's own sessionFrame, or what its host handed it. */
function sessionFrameValue(file: string): string {
  return file === "App.tsx" ? "onSessionFrame={sessionFrame}" : "onSessionFrame={props.onSessionFrame}";
}

/** A mount hands the frame on by name, through App's chatProps, or by spreading Chat's own props. */
function handsOn(mount: Mount): boolean {
  if (mount.head.includes("onSessionFrame=")) return mount.head.includes(sessionFrameValue(mount.file));
  const text = sources().get(mount.file) ?? "";
  if (mount.head.includes("{...chatProps}")) {
    const start = text.indexOf("const chatProps = {");
    const frame = text.indexOf("onSessionFrame: sessionFrame,", start);
    const end = text.indexOf("return chatView ===", start);
    return start >= 0 && frame > start && frame < end;
  }
  return mount.head.includes("{...props}") && text.includes("ComponentProps<typeof Chat>");
}

const app = stripComments(read("../App.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));
const lab = stripComments(read("../lab/LabView.tsx", import.meta.url));
const wakeChip = stripComments(read("../workspace/wakeChip.ts", import.meta.url));

/** Every useEffect in App.tsx: its body text and its dependency names. */
function effects(source: string): { body: string; deps: string[] }[] {
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: { body: string; deps: string[] }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useEffect"
    ) {
      const [fn, deps] = node.arguments;
      if (fn !== undefined && deps !== undefined && ts.isArrayLiteralExpression(deps)) {
        found.push({ body: fn.getText(file), deps: deps.elements.map((e) => e.getText(file)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the wake's wiring", () => {
  it("the message box reports its focus", () => {
    expect(chat).toContain("onFocus={props.onComposerFocus}");
  });

  it("App wakes the stored session on that focus", () => {
    expect(app).toContain("onComposerFocus: wakeStored,");
    expect(app).toMatch(/const wakeStored = \(\): void => \{\s*wakeFollowsScreen\(sessions, \{/);
    expect(wakeChip).toMatch(/export function wakeFollowsScreen\([\s\S]*?sessions\.open\(\{ wake: id \}\);/);
  });

  it("App wakes the stored session when it lands on screen, keyed on its id and continuable (card 520)", () => {
    const wakers = effects(app).filter((fx) => fx.body.includes("settleWake("));
    expect(wakers).toHaveLength(1);
    expect(wakers[0].deps).toEqual(expect.arrayContaining(["replayOnScreen", "continuable"]));
    expect(wakers[0].body).toMatch(/^\(\) =>\s*settleWake\(sessions, \{ replayId: replayOnScreen,/);
  });

  it("a held chat is looked up without the woken records (card 520)", () => {
    expect(app).toMatch(/const openSession = async \([\s\S]*?const held = sessions\.findHeld\(id\);/);
    expect(app).toMatch(/const selectSession = [\s\S]*?sessions\.findHeld\(id\)/);
  });

  it("the header chip is the stored folder, then the wake's answer", () => {
    // Card 554, task 13: the chip's workspace is one value the composer's
    // playbook commands read too.
    // Fix round 3, item 4: anchored on the call's own braces, so a later
    // `woken:` line elsewhere in App cannot answer for it; the behaviour is
    // pinned in playbookAppWiring.drift.test.ts.
    const call = /const chipWorkspace = headerWorkspace\(\{([^{}]*)\}\);/.exec(app);
    expect(call, "the chip's headerWorkspace call").not.toBeNull();
    expect(call?.[1]).toContain("woken: wokenSlot?.state.workspace ?? null,");
    expect(call?.[1]).toContain("storedCwd: shownStoredCwd,");
    expect(app).toContain("workspace={chipWorkspace}");
  });

  it("the folder of a stored session cannot be changed from the chip", () => {
    expect(app).toContain("canPickFolder={viewingLive && canPickWorkspace}");
  });

  it("the first message continues on the woken socket", () => {
    expect(app).toMatch(/if \(woken !== undefined\) \{\s*sessions\.continueWoken\(woken\.key,/);
  });

  it("a session frame from a stored session continues it first, as a command does (card 504, fix round 2 and the hub and spoke fix round)", () => {
    expect(app).toMatch(
      /const sessionFrame = \(frame: ClientMessage\): boolean => \{\s*if \(replay !== null\) \{\s*if \(!continuable\) return false;\s*if \(resumeJoin\.join\(replay\.id, frame\)\) return true;\s*void resumeSession\(replay\.id, \{ frame \}\);/,
    );
    expect(app).toContain("onSessionFrame: sessionFrame,");
    // Review round 2: the frame is held with any a resume in flight carried,
    // and every one is handed to the record (resumeJoinWiring.drift.test.ts).
    expect(app).toMatch(/"frame" in first \? \[\.\.\.carried, first\.frame\] : carried/);
    expect(app).toMatch(/firstFrames: resumeJoin\.take\(ticket\)/);
  });

  // Hub and spoke fix round: the review found the Lab's Chat without the
  // session frame, so /loop and /loop stop there went to the socket in view.
  // Every mount of Chat in the tree is found on disk, so a new one is checked
  // without anybody adding it here.
  it("every Chat mount in the tree hands on the session frame", () => {
    const mounts = chatMounts();
    expect(
      mounts.map((m) => m.file),
      "positive: the scan finds the known mounts",
    ).toEqual(expect.arrayContaining(["App.tsx", "components/ChatV2.tsx", "lab/LabView.tsx"]));
    expect(mounts.length).toBeGreaterThanOrEqual(4);
    const missing = mounts
      .filter((m) => !handsOn(m))
      .map((m) => `${m.file}:${m.line} ${m.head.slice(0, 60)}`);
    expect(missing, "a Chat mount without onSessionFrame").toEqual([]);
  });

  // Hub and spoke review, round 1: a mount that names the prop with another
  // value (undefined, or some other handler) does not hand the frame on.
  it("a mount that names onSessionFrame with another value does not count", () => {
    const at = (file: string, head: string): Mount => ({ file, line: 1, head });
    expect(handsOn(at("lab/LabView.tsx", "<Chat onSessionFrame={props.onSessionFrame}"))).toBe(true);
    expect(handsOn(at("lab/LabView.tsx", "<Chat onSessionFrame={undefined}"))).toBe(false);
    expect(handsOn(at("lab/LabView.tsx", "<Chat onSessionFrame={props.sendClient}"))).toBe(false);
    expect(handsOn(at("App.tsx", "<Chat onSessionFrame={sessionFrame}"))).toBe(true);
    expect(handsOn(at("App.tsx", "<Chat onSessionFrame={sendClient}"))).toBe(false);
  });

  it("a component that forwards the session frame from its props is given it by every mount of its own", () => {
    const forwarders = chatMounts().filter((m) => m.head.includes("onSessionFrame={props.onSessionFrame}"));
    expect(
      forwarders.map((m) => m.file),
      "positive: the Lab forwards it",
    ).toContain("lab/LabView.tsx");
    for (const forwarder of forwarders) {
      // The component the mount sits in: the last one declared above it.
      const above = (sources().get(forwarder.file) ?? "").split("\n").slice(0, forwarder.line).join("\n");
      const name = [...above.matchAll(/export function (\w+)/g)].pop()?.[1];
      expect(name, forwarder.file).toBeDefined();
      const uses = mountsOf(name!);
      expect(uses.length, `positive: ${name} is mounted somewhere`).toBeGreaterThan(0);
      for (const use of uses) {
        expect(use.head, `${use.file}:${use.line}`).toContain("onSessionFrame={sessionFrame}");
      }
    }
  });

  it("a session this page woke is its own, never live elsewhere", () => {
    expect(app).toContain("const ownIds = ownSessionIds(heldRows, allSlots);");
  });

  it("a wake is let go when the stored session leaves the screen", () => {
    expect(wakeChip).toMatch(
      /if \(held\.woken && held\.sessionId !== replayId\) sessions\.close\(held\.key\);/,
    );
    expect(wakeChip).toMatch(
      /export function settleWake\([\s\S]*?releaseOffScreen\(sessions, input\.replayId\);/,
    );
    const closers = effects(app).filter((fx) => fx.body.includes("settleWake("));
    expect(closers.map((fx) => fx.deps.includes("replayOnScreen"))).toEqual([true]);
  });

  it("the Lab's message box wakes the stored session too, through the same Chat", () => {
    expect(lab).toMatch(/<Chat\b[\s\S]*?onComposerFocus=\{props\.onComposerFocus\}[\s\S]*?\/>/);
    expect(app).toMatch(/<LabView\b[\s\S]*?onComposerFocus=\{wakeStored\}[\s\S]*?\/>/);
  });
});

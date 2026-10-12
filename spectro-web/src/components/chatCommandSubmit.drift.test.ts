// Card 471, criterion 1: a command never reaches the model as a prompt.
//
// The composer's submit is the one door every draft leaves through (Enter,
// the send button and a voice transcript all land in it). It must ask
// composerSubmit first and hand a command to the command runner, so the
// draft "/clear" can never reach onSend, which would send it as a
// user_message or, during a run, as a steering_message. Read off the source,
// the way composerSteerRecall.test.ts pins the composer's wiring.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));

/** The body of the function declared by `head`. */
function bodyOf(head: string): string {
  const at = chat.indexOf(head);
  if (at < 0) throw new Error(`Chat.tsx no longer declares ${head}`);
  let depth = 0;
  for (let i = chat.indexOf("{", at); i < chat.length; i++) {
    if (chat[i] === "{") depth++;
    if (chat[i] === "}") depth--;
    if (depth === 0) return chat.slice(at, i + 1);
  }
  throw new Error(`${head} is never closed`);
}

/** Card 527: the door is `sendText`, which submit and the voice send both call. */
function submitBody(): string {
  return bodyOf("const sendText = (written: string): void => {");
}

describe("the composer's submit", () => {
  it("asks composerSubmit about the draft before anything is sent", () => {
    const body = submitBody();
    const decided = body.indexOf("composerSubmit(written)");
    expect(decided, "the draft is decided by the pure rule").toBeGreaterThan(-1);
    expect(body.indexOf("props.onSend(")).toBeGreaterThan(decided);
  });

  it("leaves through sendText, for a typed draft and for a draft finished by voice (card 527)", () => {
    const submit = bodyOf("const submit = (): void => {");
    expect(submit).toContain("sendText(draft)");
    expect(submit.indexOf("voice.finish()")).toBeGreaterThan(-1);
    expect(submit.indexOf("sendText(", submit.indexOf("voice.finish()"))).toBeGreaterThan(-1);
    expect(submit, "submit itself never calls onSend").not.toContain("props.onSend(");
  });

  it("hands a command to the command runner and returns before onSend", () => {
    const body = submitBody();
    const command = body.indexOf('kind === "command"');
    expect(command).toBeGreaterThan(-1);
    const run = body.indexOf("runCommand", command);
    const back = body.indexOf("return;", run);
    expect(run).toBeGreaterThan(command);
    expect(back).toBeGreaterThan(run);
    expect(back).toBeLessThan(body.indexOf("props.onSend("));
  });

  it("sends /loop stop as the loop's stop frame and returns before onSend (card 504, fix round 1)", () => {
    const body = submitBody();
    const stop = body.indexOf('kind === "loopStop"');
    expect(stop, "the submit knows /loop stop").toBeGreaterThan(-1);
    const frame = body.indexOf("loopStopFrame()", stop);
    expect(frame).toBeGreaterThan(stop);
    const back = body.indexOf("return;", frame);
    expect(back).toBeGreaterThan(frame);
    expect(back).toBeLessThan(body.indexOf("props.onSend("));
  });

  it("runs a command through the host's callback and nothing else", () => {
    const at = chat.indexOf("const runCommand =");
    expect(at, "the runner is declared").toBeGreaterThan(-1);
    const runner = chat.slice(at, chat.indexOf("};", at));
    expect(runner).toContain("props.onCommand");
    expect(runner).not.toContain("onSend");
  });

  it("hands the picker the same runner, so Enter on a command row runs it", () => {
    const at = chat.indexOf("useSlashPicker(");
    expect(at, "the composer mounts the picker").toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = at + "useSlashPicker".length; i < chat.length; i++) {
      if (chat[i] === "(") depth++;
      if (chat[i] === ")") depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    expect(chat.slice(at, end)).toMatch(/runCommand\s*,?\s*$/);
  });
});

// The app must not speak for the operator about the image backend.
//
// Card 222, review finding F5, read off disk — because the defect is wiring and
// this suite has no renderer. `set_image_provider` is a GESTURE message: the
// session treats it as "a human used the control in this window" and lets it
// outrank every later settings write, for the life of the session. App.tsx sent
// it with no user action whenever the configured backend had no key and the
// other one did, on every connect and every reconnect. The reviewer measured the
// frame on a hooked WebSocket.send:
//
//   sentByTheCLIENT_withNoHumanAction:
//       ["{\"type\":\"set_image_provider\",\"provider\":\"openai\"}"]
//
// From there the settings page's image-backend dropdown was dead for that
// session, under a sentence promising it applied immediately.
//
// So: one sending site, and it is the one a human clicks. The pre-selection the
// app still makes is a display decision now, resolved from the same rule the
// server resolves the backend with (imageBackend.ts / ImageProviders.withAKey),
// and it tells the session nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const appTsx = read("./App.tsx");

/** Every line that puts a set_image_provider frame on the wire. */
function sendingLines(): string[] {
  return appTsx
    .split("\n")
    .filter((line) => line.includes("set_image_provider") && line.includes("sendClient"));
}

describe("the image backend is only claimed by a human", () => {
  it("sends set_image_provider from exactly one place", () => {
    expect(sendingLines()).toHaveLength(1);
  });

  it("arms that place with the touched latch, in the same handler", () => {
    // The latch is what makes the message a gesture. A send without it — or a
    // send the latch does not cover — is the app speaking for the operator.
    const lines = appTsx.split("\n");
    const at = lines.findIndex((line) => line.includes("set_image_provider") && line.includes("sendClient"));
    expect(at).toBeGreaterThan(-1);
    const before = lines.slice(Math.max(0, at - 6), at).join("\n");
    expect(before).toContain("controlsTouched.current = true");
  });

  it("pre-selects through the shared rule rather than deciding again inline", () => {
    // The composer showing one backend while generate_image uses another is the
    // same class of defect one field over, so both sides call the same function.
    expect(appTsx).toContain("backendWithAKey(");
  });

  it("keeps the pre-selection out of the touched latch", () => {
    // A pre-selection that armed the latch would freeze the settings page just
    // as effectively as the frame it replaced.
    const at = appTsx.indexOf("backendWithAKey(");
    expect(at).toBeGreaterThan(-1);
    const effect = appTsx.slice(at, appTsx.indexOf("}, [imageKeys", at));
    expect(effect).not.toContain("controlsTouched.current = true");
    expect(effect).not.toContain("sendClient(");
  });
});

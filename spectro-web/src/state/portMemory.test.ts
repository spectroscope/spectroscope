// The desktop shell's port memory (card 168).
//
// localStorage is origin-bound, and the shell used to ask the OS for a fresh
// port on every launch — so every desktop start ran the web app on a new
// localhost:<random> origin with an EMPTY localStorage. The built-in-model
// notice greeting the owner on every boot was only the loudest victim: design,
// language, disclosure level, lab view, every spectroscope:* preference
// silently reset each start. The cure is a stable origin: remember the port
// that served last launch in userData and try it first; fall back to a fresh
// OS-assigned port only when the remembered one is taken.
//
// The decision is a pure function in spectro-desktop, which has no test rig
// of its own (tsc only) — so, like cacheRecovery.test.ts one file over, the
// desktop half is tested from here. The pure module imports nothing from
// electron, which is what makes the direct import possible.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readRememberedPort,
  rememberedPortPayload,
  shouldPersistPort,
} from "../../../spectro-desktop/src/portMemory";

describe("the marker file round-trip", () => {
  it("reads back the port it wrote", () => {
    const raw = rememberedPortPayload(53441);
    expect(readRememberedPort(raw)).toBe(53441);
  });

  it("treats a missing marker as absent — the first launch with this feature", () => {
    expect(readRememberedPort(null)).toBeNull();
  });

  it("treats a corrupt marker as absent rather than throwing", () => {
    expect(readRememberedPort("not json {")).toBeNull();
    expect(readRememberedPort(JSON.stringify({ port: "53441" }))).toBeNull();
    expect(readRememberedPort(JSON.stringify({ version: "0.6.0" }))).toBeNull();
  });

  it("rejects port 0 — passing it through would re-summon the random-port amnesia", () => {
    expect(readRememberedPort(JSON.stringify({ port: 0 }))).toBeNull();
  });

  it("rejects values that are not a bindable TCP port", () => {
    expect(readRememberedPort(JSON.stringify({ port: -1 }))).toBeNull();
    expect(readRememberedPort(JSON.stringify({ port: 65536 }))).toBeNull();
    expect(readRememberedPort(JSON.stringify({ port: 53441.5 }))).toBeNull();
  });
});

describe("the persist decision", () => {
  it("persists on the first launch — nothing was remembered yet", () => {
    expect(shouldPersistPort(null, 53441)).toBe(true);
  });

  it("persists when the fallback moved us to a fresh port", () => {
    expect(shouldPersistPort(53441, 53500)).toBe(true);
  });

  it("does not rewrite the marker on an ordinary restart — the port held", () => {
    expect(shouldPersistPort(53441, 53441)).toBe(false);
  });
});

describe("the shell's half of the wire", () => {
  // Same rationale as the cacheRecovery wire: the two halves live in different
  // projects with different build systems and nothing else connects them.
  // A pure function nobody calls would pass every case above and remember
  // nothing.
  const shell = readFileSync(
    fileURLToPath(new URL("../../../spectro-desktop/src/main.ts", import.meta.url)),
    "utf8",
  );

  it("actually reads the remembered port before asking the OS for one", () => {
    expect(shell).toContain("readRememberedPort");
    expect(shell).toContain("SERVER_PORT_FILE");
  });

  it("persists the chosen port under userData for the next launch", () => {
    expect(shell).toContain("rememberedPortPayload");
    expect(shell).toContain("shouldPersistPort");
  });

  it("offers an isolated-profile seam so a dev shell never collides with the installed app", () => {
    // Dev `electron .` and the packaged app share the SAME userData (the
    // electron-builder productName is not the runtime app.name), so without an
    // override a dev launch hands off to the running installed app via the
    // Chromium singleton and silently quits — which is also what makes the
    // card-168 two-launch verification impossible while the real app runs.
    expect(shell).toContain("SPECTRO_DESKTOP_USERDATA");
  });
});

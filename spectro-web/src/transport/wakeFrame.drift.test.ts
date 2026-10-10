// Card 498: the wake frame, held against the server that answers it.
//
// The page sends wake_session and the Java socket handler routes it. Neither
// side can see the other, so this test reads both: the handler's case, the
// ClientMessage union in events.ts, and the socket-only list, which is the
// standing answer to "may a file hold this" and says no for a wake.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOCKET_ONLY_TYPES, isWireEvent } from "../wire/nonWire";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const HANDLER =
  "../../../spectro-server/src/main/java/dev/spectroscope/server/session/SpectroSocketHandler.java";

describe("wake_session", () => {
  it("is a case of the server's socket handler", () => {
    expect(read(HANDLER)).toContain('case "wake_session" ->');
  });

  it("is a frame of the client union, carrying only the session id", () => {
    expect(read("../events.ts")).toContain('| { type: "wake_session"; sessionId: string }');
  });

  it("is in the socket-only list and never reaches a session file", () => {
    expect(SOCKET_ONLY_TYPES.has("wake_session")).toBe(true);
    expect(isWireEvent({ type: "wake_session" })).toBe(false);
  });
});

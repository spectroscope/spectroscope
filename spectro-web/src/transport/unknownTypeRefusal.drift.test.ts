// The one string the client's version-skew guard keys on, held against its
// source in the server.
//
// Card 261 review. A page carrying the liveness probe can meet a server built
// before `case "ping"` existed. That server falls to SpectroSocketHandler's
// default arm — sendError("Unknown message type.") — and sendError is a
// first-class RunEvent: it goes through send() and is APPENDED to the session
// JSONL. A probe every fifteen seconds of idling would fill the operator's
// chat and his record on disk with error rows.
//
// isUnknownTypeError() in ws.ts recognises exactly that text and stops asking.
// Which makes the text a contract between two languages with no shared module,
// and the failure mode of a drift is the worst kind: the guard goes dead, the
// probe starts again, and nothing anywhere is red — the operator just finds
// error rows in his session file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isUnknownTypeError } from "./ws";

const handler = readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "spectro-server",
    "src",
    "main",
    "java",
    "dev",
    "spectroscope",
    "server",
    "session",
    "SpectroSocketHandler.java",
  ),
  "utf8",
);

describe("the refusal an older server answers a probe with", () => {
  it("is the exact text the client's guard recognises", () => {
    expect(handler).toContain('default -> connection.sendError("Unknown message type.");');
    expect(isUnknownTypeError({ type: "error", message: "Unknown message type." })).toBe(true);
  });

  it("is recognised only on an error frame, and only word for word", () => {
    // A guard that matched loosely would swallow real errors from the agent.
    expect(isUnknownTypeError({ type: "error", message: "Unknown message type" })).toBe(false);
    expect(isUnknownTypeError({ type: "error", message: "Tool failed." })).toBe(false);
    expect(isUnknownTypeError({ type: "text_delta", message: "Unknown message type." })).toBe(false);
    expect(isUnknownTypeError({})).toBe(false);
  });

  it("is unreachable for `ping` on a server that has the case", () => {
    // The other half: this server answers, so its own clients never meet the
    // refusal at all. If this line goes, the guard above is all that is left.
    expect(handler).toContain('case "ping" -> connection.sendPong();');
  });
});

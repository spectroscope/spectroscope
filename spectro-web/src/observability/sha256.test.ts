// Pins the pure SHA-256 the trace deep link is built on (card 137).
//
// Why a hand-written digest rather than SubtleCrypto: this is a NAMING
// function, not a security boundary. A wrong digest yields a wrong URL, never
// a weakened secret. SubtleCrypto is async (so a pure traceUrl() would become
// an effect plus state) and secure-context gated (so the link would silently
// never appear in setups we cannot enumerate). The cost of hand-rolling is
// paid here: NIST vectors, a multi-block case and a non-ascii case, each
// cross-checked against crypto.subtle where it exists.

import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

/** The reference digest, from the platform, for cross-checking. */
async function subtleHex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("sha256Hex", () => {
  it("empty string matches the NIST vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("abc matches the NIST vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("spans multiple blocks", async () => {
    // 1000 chars is 16 blocks: catches a length field written only for the
    // first block, and a message schedule that never rolls over.
    const long = "spectroscope".repeat(84).slice(0, 1000);
    expect(long).toHaveLength(1000);
    expect(sha256Hex(long)).toBe(await subtleHex(long));
  });

  it("encodes non-ascii as utf-8", async () => {
    // A naive charCodeAt byte loop passes every ascii test above and fails
    // exactly here: "ü" is two bytes and the telescope is a surrogate pair.
    const text = "grüße 🔭";
    expect(sha256Hex(text)).toBe(await subtleHex(text));
  });

  it("returns 64 lowercase hex characters", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

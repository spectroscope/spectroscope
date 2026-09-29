// Release 0.14.2, live check D1: App hands the header chip the pair from
// headerBackend, for the live view and for a stored session read from its record.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

describe("App wires the header chip through headerBackend (0.14.2 D1)", () => {
  it("both the provider and the model the header gets come from one headerBackend call", () => {
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toMatch(/const chip = headerBackend\(\{/);
    expect(app).toMatch(
      /viewingLive,\s*recorded:\s*\{\s*provider:\s*view\.provider,\s*model:\s*view\.runModel\s*\}/,
    );
    // Card 463: the pair reaches the model chip under the composer.
    expect(app).toMatch(/composerMeta:\s*\{\s*provider:\s*chip\.provider,\s*model:\s*chip\.model,/);
  });
});

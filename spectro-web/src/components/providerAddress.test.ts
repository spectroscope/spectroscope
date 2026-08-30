// Card 193, the logic half: each local-model provider owns an address field
// with its OWN preset as placeholder, every other provider hides it, and the
// "backend not reachable" sentence names the exact address the probe tried.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { addressSpecFor, localDownNote } from "./providerAddress";
import { PROVIDERS } from "./providerPickerMode";

describe("addressSpecFor", () => {
  // The test that stood here was called "gives each local-model provider its
  // own field and its own preset" and then named two of the three by hand, so
  // llamacpp joined without it noticing and the name went on claiming the
  // coverage (card 312, round 3). Every provider is walked now, and what is
  // asserted is the SHAPE the card-193 rule requires of an owner — a field of
  // its own name, a loopback preset, and a port nobody else has. The defect
  // that rule exists for was one provider borrowing another's port.
  it("gives every address owner its own field, on its own port", () => {
    const owners = PROVIDERS.filter((p) => addressSpecFor(p) !== null);
    expect(owners.length, "no provider owns an address any more").toBeGreaterThanOrEqual(2);
    const ports = new Set<string>();
    for (const p of owners) {
      const spec = addressSpecFor(p)!;
      expect(spec.field, `${p}'s field is not its own name`).toBe(`${p}BaseUrl`);
      const port = spec.preset.match(/^http:\/\/localhost:(\d+)$/)?.[1];
      expect(port, `${p}'s preset is not a loopback address with a port: ${spec.preset}`).toBeDefined();
      expect(ports.has(port!), `${p} shares port ${port} with another provider`).toBe(false);
      ports.add(port!);
    }
  });

  it("answers null for every provider that is not an owner — the field stays hidden", () => {
    // No skip list: the owners are read off addressSpecFor itself, and WHICH
    // providers those are is pinned against the server's own answer in
    // settingsReach.test.tsx and llamacppProvider.test.ts. Left that way with a
    // reason: on the web side addressSpecFor IS the source, so a second copy
    // here would be the hand-typed list this round is removing, not a check.
    const owners = new Set(PROVIDERS.filter((p) => addressSpecFor(p) !== null));
    const hidden = PROVIDERS.filter((p) => !owners.has(p));
    expect(hidden.length, "every provider owns an address — the row can never hide").toBeGreaterThan(0);
    for (const p of hidden) {
      expect(addressSpecFor(p), p).toBeNull();
    }
  });
});

describe("localDownNote", () => {
  it("names the address the probe tried when the server reports one", () => {
    const note = localDownNote("ollama", { ollama: "http://gpu-box:11434" });
    expect(note.key).toBe("pp.localDownAt");
    expect(note.vars).toEqual({ addr: "http://gpu-box:11434" });
    for (const lang of ["de", "en"] as const) {
      const sentence = t(lang, note.key, note.vars);
      expect(sentence).toContain("http://gpu-box:11434");
      expect(sentence).not.toContain("{addr}");
      expect(sentence).not.toBe(note.key); // the key resolves in both languages
    }
  });

  it("falls back to the addressless sentence against an older server", () => {
    // /api/config without providerAddress (a pre-193 server) must not render
    // an empty hole where the address would go.
    expect(localDownNote("ollama", undefined).key).toBe("pp.localDown");
    expect(localDownNote("ollama", { lmstudio: "http://x:1" }).key).toBe("pp.localDown");
  });
});

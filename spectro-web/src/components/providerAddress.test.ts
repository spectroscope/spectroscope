// Card 193, the logic half: each local-model provider owns an address field
// with its OWN preset as placeholder, every other provider hides it, and the
// "backend not reachable" sentence names the exact address the probe tried.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { addressSpecFor, localDownNote } from "./providerAddress";
import { PROVIDERS } from "./providerPickerMode";

describe("addressSpecFor", () => {
  it("gives each local-model provider its own field and its own preset", () => {
    expect(addressSpecFor("ollama")).toEqual({
      field: "ollamaBaseUrl",
      preset: "http://localhost:11434",
    });
    expect(addressSpecFor("lmstudio")).toEqual({
      field: "lmstudioBaseUrl",
      preset: "http://localhost:1234",
    });
  });

  it("answers null for every provider without an address — the field stays hidden", () => {
    for (const p of PROVIDERS) {
      if (p === "ollama" || p === "lmstudio" || p === "llamacpp") continue;
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

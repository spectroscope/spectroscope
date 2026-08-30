// Card 193, the logic half: each local-model provider owns an address field
// with its OWN preset as placeholder, every other provider hides it, and the
// "backend not reachable" sentence names the exact address the probe tried.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { addressOverrideNote, addressSpecFor, LEGACY_SHARED_DEFAULT, localDownNote } from "./providerAddress";
import { PROVIDERS } from "./providerPickerMode";
import type { Origin, SettingsView } from "../state/serverSettings";

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
      if (p === "ollama" || p === "lmstudio") continue;
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

// ── Card 311: the address that loses says so ─────────────────────────────────
// Card 193 made a provider's OWN address win over the general one, and gave
// the doctor a line that says the quiet part out loud. The settings page never
// got that line: the owner typed an address into the general field, watched
// every request go somewhere else, and was told only that "the backend" was
// unreachable at an address he had not chosen. The precedence is unchanged
// here; the silence is what this closes.

/** A SettingsView stub carrying only what the note reads. */
function viewWith(effective: Record<string, unknown>, origins: Record<string, Origin>): SettingsView {
  return { effective, origins, layers: {}, files: {}, workspace: null };
}

const set = (winner: string): Origin => ({ winner, shadowed: [] });
const unset: Origin = { winner: "defaults", shadowed: [] };

describe("addressOverrideNote", () => {
  it("reports the override when a per-provider address AND a general one are both set", () => {
    const note = addressOverrideNote(
      "lmstudio",
      viewWith(
        { lmstudioBaseUrl: "http://localhost:1234", baseUrl: "http://localhost:8600" },
        { lmstudioBaseUrl: set("user"), baseUrl: set("user") },
      ),
      "en",
      { lmstudio: "http://localhost:1234" },
    );
    expect(note).not.toBeNull();
    expect(note?.vars.field).toBe("lmstudioBaseUrl");
    expect(note?.vars.addr).toBe("http://localhost:1234");
  });

  it("names the winning address, both layers and the provider, in both languages", () => {
    // Both providers, because both dict entries carry the same five holes and
    // one sentence proves nothing about the other.
    const cases = [
      { provider: "ollama", field: "ollamaBaseUrl", addr: "http://gpu-box:11434" },
      { provider: "lmstudio", field: "lmstudioBaseUrl", addr: "http://gpu-box:1234" },
    ] as const;
    for (const { provider, field, addr } of cases) {
      for (const lang of ["de", "en"] as const) {
        const note = addressOverrideNote(
          provider,
          viewWith(
            { [field]: addr, baseUrl: "http://elsewhere:8600" },
            { [field]: set("env"), baseUrl: set("flags") },
          ),
          lang,
          { [provider]: addr },
        );
        const where = `${provider}/${lang}`;
        const sentence = t(lang, note!.key, note!.vars);
        expect(sentence, where).not.toBe(note!.key); // the key resolves
        expect(sentence, where).not.toMatch(/\{[a-z]+\}/i); // every hole filled
        expect(sentence, where).toContain(addr); // the winner
        expect(sentence, where).toContain(field); // the field that wins
        // {provider} cannot be pinned by looking for the provider name in the
        // whole sentence: {field} already renders as "ollamaBaseUrl", which
        // CONTAINS "ollama", so the sought word is a substring of its own
        // neighbour and the check is green in both directions — measured, with
        // {provider} struck out of the en entry the old assertion still passed.
        // Strike the field token out and ask what is left.
        expect(sentence.split(field).join(""), where).toContain(provider);
        expect(sentence, where).toContain(t(lang, "set.layer.env")); // the winner's layer
        expect(sentence, where).toContain(t(lang, "set.layer.flags")); // the loser's layer
      }
    }
  });

  it("says nothing when only the general address is set — nothing is being overridden", () => {
    expect(
      addressOverrideNote(
        "lmstudio",
        viewWith(
          { lmstudioBaseUrl: null, baseUrl: "http://localhost:8600" },
          { lmstudioBaseUrl: unset, baseUrl: set("user") },
        ),
        "en",
      ),
    ).toBeNull();
  });

  it("says nothing when only the per-provider address is set", () => {
    expect(
      addressOverrideNote(
        "ollama",
        viewWith(
          { ollamaBaseUrl: "http://gpu-box:11434", baseUrl: "http://localhost:11434" },
          { ollamaBaseUrl: set("user"), baseUrl: unset },
        ),
        "en",
      ),
    ).toBeNull();
  });

  it("says nothing for a blank per-provider address — a blank one does NOT win", () => {
    // Hand-edited settings.json: the key is present, so the fold hands it a
    // layer and the origin says "user" — but effectiveLmstudioBaseUrl treats a
    // blank as unset and the general address is what gets dialled. A note here
    // would be the opposite of the truth.
    expect(
      addressOverrideNote(
        "lmstudio",
        viewWith(
          { lmstudioBaseUrl: "  ", baseUrl: "http://localhost:8600" },
          { lmstudioBaseUrl: set("user"), baseUrl: set("user") },
        ),
        "en",
      ),
    ).toBeNull();
  });

  it("says nothing for a blank general address — there is no loser to name", () => {
    expect(
      addressOverrideNote(
        "ollama",
        viewWith(
          { ollamaBaseUrl: "http://gpu-box:11434", baseUrl: "" },
          { ollamaBaseUrl: set("user"), baseUrl: set("user") },
        ),
        "en",
      ),
    ).toBeNull();
  });

  it("says nothing for a provider without an address field of its own", () => {
    for (const p of PROVIDERS) {
      if (p === "ollama" || p === "lmstudio") continue;
      expect(
        addressOverrideNote(
          p,
          viewWith({ baseUrl: "http://localhost:8600" }, { baseUrl: set("user") }),
          "en",
        ),
        p,
      ).toBeNull();
    }
  });

  it("says nothing while the view has not loaded", () => {
    expect(addressOverrideNote("lmstudio", null, "en")).toBeNull();
  });

  it("names the server's own endpointFor when it has one, the folded field otherwise", () => {
    // One truth, three faces: /api/config's providerAddress IS endpointFor, so
    // the settings page names the string the probe and the run dial. Against a
    // server that reports none, the folded per-provider field is the same value
    // by construction — it is the one that wins — so the note still stands.
    const view = viewWith(
      { lmstudioBaseUrl: "http://gpu-box:1234", baseUrl: "http://elsewhere:8600" },
      { lmstudioBaseUrl: set("user"), baseUrl: set("user") },
    );
    expect(
      addressOverrideNote("lmstudio", view, "en", { lmstudio: "http://probe-said:1234" })?.vars.addr,
    ).toBe("http://probe-said:1234");
    expect(addressOverrideNote("lmstudio", view, "en")?.vars.addr).toBe("http://gpu-box:1234");
  });

  it("does not blame the override for a general address that would not have applied", () => {
    // The corner the doctor's twin covers. lmstudio's general fallback runs
    // through the openai-compat rule, which reads the legacy shared default as
    // "unset" — so this operator is not losing his typed address TO
    // lmstudioBaseUrl; he never had it. Clearing the per-provider field to get
    // it back would land him on LM Studio's preset instead, which is exactly
    // what the causal sentence talks him into doing.
    const note = addressOverrideNote(
      "lmstudio",
      viewWith(
        { lmstudioBaseUrl: "http://gpu-box:1234", baseUrl: LEGACY_SHARED_DEFAULT },
        { lmstudioBaseUrl: set("user"), baseUrl: set("flags") },
      ),
      "en",
      { lmstudio: "http://gpu-box:1234" },
    );
    expect(note?.key).toBe("set.addressOverrideLegacyDefault");
    expect(note?.vars.fallback).toBe("http://localhost:1234");
    for (const lang of ["de", "en"] as const) {
      const sentence = t(lang, note!.key, note!.vars);
      expect(sentence, lang).not.toBe(note!.key); // the key resolves
      expect(sentence, lang).not.toMatch(/\{[a-z]+\}/i); // every hole filled
      expect(sentence, lang).toContain("http://localhost:1234"); // where clearing lands
      expect(sentence, lang).toContain("http://gpu-box:1234"); // still the winner
      expect(sentence, lang).toContain(LEGACY_SHARED_DEFAULT); // the value read as unset
    }
  });

  it("keeps the causal sentence for ollama, which has no such corner", () => {
    // effectiveOllamaBaseUrl carries no sentinel: any non-blank general value
    // is taken verbatim, the legacy default included. So for ollama the
    // general address really would apply once the per-provider field is empty.
    //
    // What this pins is the SENTENCE, not the arm that produced it: ollama's
    // own preset IS the legacy shared default, so generalFallbackFor's two
    // arms return the same string here and dropping its ollama short-circuit
    // leaves this green (measured). The arms are held apart on the doctor's
    // side, where the twin calls the two effective* methods instead of
    // comparing literals — biting either one there is red.
    expect(
      addressOverrideNote(
        "ollama",
        viewWith(
          { ollamaBaseUrl: "http://gpu-box:11434", baseUrl: LEGACY_SHARED_DEFAULT },
          { ollamaBaseUrl: set("user"), baseUrl: set("flags") },
        ),
        "en",
        { ollama: "http://gpu-box:11434" },
      )?.key,
    ).toBe("set.addressOverride");
  });
});

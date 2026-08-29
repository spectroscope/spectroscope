// Card 193, the logic half: each local-model provider owns an address field
// with its OWN preset as placeholder, every other provider hides it, and the
// "backend not reachable" sentence names the exact address the probe tried.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { addressOverrideNote, addressSpecFor, localDownNote } from "./providerAddress";
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
    for (const lang of ["de", "en"] as const) {
      const note = addressOverrideNote(
        "ollama",
        viewWith(
          { ollamaBaseUrl: "http://gpu-box:11434", baseUrl: "http://elsewhere:8600" },
          { ollamaBaseUrl: set("env"), baseUrl: set("flags") },
        ),
        lang,
        { ollama: "http://gpu-box:11434" },
      );
      const sentence = t(lang, note!.key, note!.vars);
      expect(sentence, lang).not.toBe(note!.key); // the key resolves
      expect(sentence, lang).not.toMatch(/\{[a-z]+\}/i); // every hole filled
      expect(sentence, lang).toContain("http://gpu-box:11434"); // the winner
      expect(sentence, lang).toContain("ollamaBaseUrl"); // the field that wins
      expect(sentence, lang).toContain("ollama"); // the provider it applies to
      expect(sentence, lang).toContain(t(lang, "set.layer.env")); // the winner's layer
      expect(sentence, lang).toContain(t(lang, "set.layer.flags")); // the loser's layer
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
});

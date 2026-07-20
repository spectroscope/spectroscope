// Chrome localisation: every dict entry carries BOTH languages, t() fills
// placeholders, and unknown keys pass through loudly (they render as the key).
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";

describe("i18n dict", () => {
  it("every entry has a German and an English string", () => {
    for (const [key, entry] of Object.entries(dict)) {
      expect(entry.de, `${key}.de`).toBeTruthy();
      expect(entry.en, `${key}.en`).toBeTruthy();
    }
  });

  it("covers every enum-built key family (components interpolate these)", () => {
    // map.gate.<GateState> / map.life.<state> / gk.<GraphNode kind>
    for (const g of ["none", "pending", "allowed", "denied"]) {
      expect(dict[`map.gate.${g}`], `map.gate.${g}`).toBeDefined();
    }
    for (const s of ["submitted", "working", "completed", "failed"]) {
      expect(dict[`map.life.${s}`], `map.life.${s}`).toBeDefined();
    }
    for (const k of ["user", "turn", "tool", "subagent", "answer"]) {
      expect(dict[`gk.${k}`], `gk.${k}`).toBeDefined();
    }
    for (const p of ["pending", "in_progress", "completed"]) {
      expect(dict[`plan.${p}`], `plan.${p}`).toBeDefined();
    }
  });
});

describe("t", () => {
  it("resolves a key per language", () => {
    expect(t("de", "nav.newChat")).toBe("Neuer Chat");
    expect(t("en", "nav.newChat")).toBe("New chat");
  });

  it("fills {var} placeholders", () => {
    expect(t("en", "gv.events", { n: 3, total: 10 })).toBe("3/10 events");
    expect(t("de", "perm.queue", { i: 1, n: 2 })).toBe("1 von 2");
  });

  it("passes unknown keys through unchanged (a missing entry shows loudly)", () => {
    expect(t("de", "nope.missing")).toBe("nope.missing");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STOP_REASONS, stopReasonKey } from "./stopReason";
import { dict, t } from "../i18n/i18n";

// Card 282, criterion 9: the footer stops printing the raw wire word.
//
// The owner's report is the whole reason this exists. A run ended on max_turns,
// and UsageFooter rendered "gestoppt · {r}" with the wire value substituted in,
// so a German operator read "gestoppt · max_turns" — English machine vocabulary
// inside a localised sentence, which is this card's own non-functional
// criterion 2 being broken by the code it extends.

const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

describe("every stop reason the harness can write has a sentence", () => {
  it.each([...STOP_REASONS])("%s reads in de and en", (reason) => {
    const entry = dict[stopReasonKey(reason)];
    expect(entry, `${reason} has no sentence — the footer would print the wire word`).toBeDefined();
    expect(entry.de).not.toBe(entry.en);
    // The negative goes on the KEY and on the wire word, never on a rendered
    // phrase: not.toContain("stopped") would be green for a footer printing
    // nothing at all.
    for (const lang of ["de", "en"] as const) {
      expect(t(lang, stopReasonKey(reason))).not.toBe(stopReasonKey(reason));
    }
  });

  it("gives a reason this build has never seen a line rather than silence", () => {
    const key = stopReasonKey("a_reason_from_the_future");
    expect(key).toBe("stop.other");
    for (const lang of ["de", "en"] as const) {
      expect(t(lang, key, { reason: "a_reason_from_the_future" })).toContain(
        "a_reason_from_the_future",
      );
    }
  });

  it("names every reason the Java actually writes", () => {
    // Read off disk rather than remembered. The list is assembled in three
    // places — Agent.stopReasonName's switch, the STOP_REASON constants on the
    // guard and the leash, and the goal check's three verdicts — so a fourth
    // source added later cannot be caught by memory.
    const sources = [
      "spectro-core/src/main/java/dev/spectroscope/core/Agent.java",
      "spectro-core/src/main/java/dev/spectroscope/core/progress/ProgressGuard.java",
      "spectro-core/src/main/java/dev/spectroscope/core/loop/ContinuationLeash.java",
    ].map(java);
    const written = new Set<string>();
    for (const source of sources) {
      for (const m of source.matchAll(/STOP_REASON\w*\s*=\s*"([a-z_]+)"/g)) written.add(m[1]);
      for (const m of source.matchAll(/->\s*"([a-z_]+)";/g)) written.add(m[1]);
    }
    expect(written.size, "the walker found nothing — the Java's shape moved").toBeGreaterThan(4);
    for (const reason of written) {
      expect(
        STOP_REASONS.has(reason),
        `${reason} is written by the harness and falls to the generic line`,
      ).toBe(true);
    }
  });
});

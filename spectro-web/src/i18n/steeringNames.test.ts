import { describe, expect, it } from "vitest";
import { dict } from "./i18n";

/**
 * Card 380, criterion 1: the name lives in one place.
 *
 * The house calls this act steering, and German calls it Zuruf. The point of
 * the test is not the spelling but the SEPARATION: queue already means the
 * opposite thing twice in this dictionary, once as the send button's label
 * while a run is up and once as the Lab's imported queue seat. A new key that
 * read like either of those would put one word on the two behaviours a reader
 * most needs to tell apart.
 */
describe("the steering vocabulary", () => {
  const steeringKeys = Object.keys(dict).filter((key) => key.startsWith("chat.steer"));

  it("is actually in the dictionary", () => {
    expect(steeringKeys.length).toBeGreaterThan(0);
  });

  it("says Zuruf in German and steering message in English", () => {
    const de = steeringKeys.map((key) => dict[key].de).join(" ");
    const en = steeringKeys.map((key) => dict[key].en).join(" ");

    expect(de).toContain("Zuruf");
    expect(en.toLowerCase()).toContain("steering message");
  });

  it("carries both languages on every one of its keys", () => {
    for (const key of steeringKeys) {
      expect(dict[key].de, key).toBeTruthy();
      expect(dict[key].en, key).toBeTruthy();
    }
  });

  it("duplicates none of the three strings the queue already owns", () => {
    // Derived from the dictionary, not typed out twice: a hand list guarded by
    // a test that types the same hand list is two copies of one claim.
    const taken = ["chat.queue", "chat.queuedHint", "lab.queue.title"].flatMap((key) => [
      dict[key].de,
      dict[key].en,
    ]);

    for (const key of steeringKeys) {
      expect(taken, key).not.toContain(dict[key].de);
      expect(taken, key).not.toContain(dict[key].en);
    }
  });

  // Fix round 2026-09-24, item 2. The card says the run reads the sentence "at
  // its next safe point", and the pending row uses those words rather than a
  // paraphrase, in both languages.
  it("names the pending row with the card's own words", () => {
    expect(dict["chat.steerPending"]?.en).toContain("next safe point");
    expect(dict["chat.steerPending"]?.de).toContain("nächsten sicheren Punkt");
  });

  it("has a word for each of the two outcomes, in both languages", () => {
    for (const key of ["chat.steerDelivered", "chat.steerUndelivered"]) {
      expect(dict[key]?.en, key).toBeTruthy();
      expect(dict[key]?.de, key).toBeTruthy();
    }
    expect(dict["chat.steerDelivered"]?.en).not.toBe(dict["chat.steerUndelivered"]?.en);
    expect(dict["chat.steerDelivered"]?.de).not.toBe(dict["chat.steerUndelivered"]?.de);
  });

  it("no longer blames the turn cap for every sentence a run missed", () => {
    // Every exit now hands the sentence back, not only the cap, and the note
    // says where it goes: the next message, which is owner call 3.
    expect(dict["chat.steerNotTaken"]?.en).not.toContain("last turn");
    expect(dict["chat.steerNotTaken"]?.en).toContain("next message");
    expect(dict["chat.steerNotTaken"]?.de).toContain("nächste Nachricht");
  });
});

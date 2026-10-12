// Card 527, fix round: the speech model card covers the composer only on the
// local route. A hosted press also waits for ready, but loads no local model,
// so the card and its file name would say something untrue there. The rule is
// speechModelLoads in voiceButton.ts; this file pins that Chat asks it, with
// the route the press takes, before it renders the card, and that the mic
// label gets the same route. Read off the source, the way
// chatCommandSubmit.drift.test.ts pins the composer's wiring.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));

describe("the speech model card in Chat", () => {
  it("renders only behind speechModelLoads with the press's route and the loading word", () => {
    const sites = [...chat.matchAll(/<SpeechModelOpening\b/g)].map((m) => m.index ?? 0);
    expect(sites.length, "Chat renders the card").toBeGreaterThan(0);
    for (const at of sites) {
      const before = chat.slice(Math.max(0, at - 160), at);
      // Card 528: and with the hook's word that the model really loads.
      expect(before).toMatch(
        /speechModelLoads\(voice\.micPhase, live\.route, voice\.modelLoading\)\s*&&\s*\(?\s*$/,
      );
    }
  });

  it("names the model the live socket runs", () => {
    expect(chat).toMatch(/<SpeechModelOpening[^>]*model=\{sttStatus\?\.localLive\?\.model\b/);
  });

  it("gives the mic label the same route", () => {
    expect(chat).toMatch(/micButtonState\(voice\.micPhase, voice\.micAvailable, lang, live\.route\)/);
  });
});

// The fence note answers instead of announcing (card 355).
//
// The owner asked what the browser panel's footer was telling him. Measuring
// the answer produced the finding: it told him to obtain `allowLocalhost`,
// which his own ~/.spectro/settings.json already sets. One frozen string, two
// render sites, the same sentence for everybody forever.
//
// What this suite holds, in the card's order:
//   1. the note is a function of the fence state, and the clause telling the
//      reader to obtain the opt-in is gone once he has it;
//   2. the DNS admission is in EVERY variant — it is the most valuable half of
//      the note and the one brevity would eat first;
//   - and the composed sentence stays inside card 228's terse register, which
//      the pieces could otherwise walk past one fragment at a time.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fenceNote, readLoopbackGate, type LoopbackGate } from "./fenceNote";
import { __setTestHooks } from "../state/serverSettings";
import { dict, t, type Lang } from "../i18n/i18n";

const langs: Lang[] = ["de", "en"];
const gates: LoopbackGate[] = [true, false, null];

describe("the note says what applies to THIS session", () => {
  it("is not the same sentence whatever the fence says", () => {
    // The defect itself, said as a test: a footer rendered unconditionally
    // cannot be wrong about one reader without being wrong about him always.
    for (const lang of langs) {
      const on = fenceNote(lang, true);
      const off = fenceNote(lang, false);
      const unknown = fenceNote(lang, null);
      expect(on, `${lang}: the opt-in on and off read alike`).not.toEqual(off);
      expect(on, `${lang}: the opt-in on reads like nobody having said`).not.toEqual(unknown);
      expect(off, `${lang}: the opt-in off reads like nobody having said`).not.toEqual(unknown);
    }
  });

  it("stops telling him to obtain the opt-in once he has it", () => {
    for (const lang of langs) {
      const needsIt = t(lang, "browser.fence.loopbackOff");
      expect(fenceNote(lang, false), `${lang}: off must say what is missing`).toContain(needsIt);
      expect(fenceNote(lang, true), `${lang}: on must not ask for what is granted`).not.toContain(needsIt);
    }
  });

  it("says loopback is reachable only where it is", () => {
    for (const lang of langs) {
      const reaches = t(lang, "browser.fence.loopbackOn");
      expect(fenceNote(lang, true), `${lang}: on must say so`).toContain(reaches);
      expect(fenceNote(lang, false), `${lang}: off must not promise the reach`).not.toContain(reaches);
    }
  });

  it("claims neither state while nobody has said", () => {
    // Null is the settings read in flight, or failed. Card 344's rule one file
    // over: an unknown answer leaves the surface alone. Guessing "off" here
    // would put card 355's own sentence back on the screen for the whole
    // window; guessing "on" would promise a reach the fence may refuse.
    for (const lang of langs) {
      const unknown = fenceNote(lang, null);
      expect(unknown, `${lang}: unknown must not ask for the opt-in`).not.toContain(
        t(lang, "browser.fence.loopbackOff"),
      );
      expect(unknown, `${lang}: unknown must not promise the reach`).not.toContain(
        t(lang, "browser.fence.loopbackOn"),
      );
    }
  });
});

describe("the honest limit survives every variant", () => {
  it("admits the DNS answer that changes after the check, whatever the opt-in is", () => {
    // Criterion 2, the starred one. This sentence is the reason the note is
    // worth keeping at all: it names what no fence catches. It must not be the
    // piece that a shorter footer drops.
    for (const lang of langs) {
      for (const gate of gates) {
        expect(fenceNote(lang, gate), `${lang}/${String(gate)} dropped the DNS limit`).toContain(
          t(lang, "browser.fence.dns"),
        );
      }
    }
  });

  it("keeps the DNS sentence about a resolver, not about a rule the fence enforces", () => {
    // Moved here from i18n.test.ts, which pinned it on the old single key.
    expect(dict["browser.fence.dns"].en).toMatch(/DNS answer that changes/);
    expect(dict["browser.fence.dns"].de).toMatch(/DNS-Antwort, die sich/);
  });

  it("still names the rules that hold whatever the settings say", () => {
    for (const lang of langs) {
      for (const gate of gates) {
        const note = fenceNote(lang, gate);
        expect(note, `${lang}/${String(gate)} lost file://`).toContain("file://");
        expect(note, `${lang}/${String(gate)} lost the rules`).toContain(t(lang, "browser.fence.rules"));
      }
    }
  });
});

describe("the composed footer stays terse (card 228)", () => {
  it("is under 200 characters in every language and every fence state", () => {
    // The register guard in i18n.test.ts measures single keys. Splitting one
    // string into four fragments would slip past it while the sentence the
    // operator actually reads grew — so the composition is measured here,
    // where the composition happens. Measured on the way in: the sentence
    // this replaces was 178 (en) and 193 (de).
    for (const lang of langs) {
      for (const gate of gates) {
        const note = fenceNote(lang, gate);
        expect(note.length, `${lang}/${String(gate)} is ${note.length} chars: ${note}`).toBeLessThanOrEqual(
          200,
        );
      }
    }
  });
});

// Where the gate comes from. The note can only be right about this process if
// something asks this process — `grep allowLocalhost spectro-web/src/browser/`
// found nothing at all when card 355 was written, which is why the note could
// not have been anything but a recitation.
describe("the gate is read from the settings the fence was built from", () => {
  afterEach(() => __setTestHooks({}));

  /** Answers one settings view, and records what was asked for. */
  function serve(effective: Record<string, unknown>): { urls: string[] } {
    const urls: string[] = [];
    __setTestHooks({
      fetchFn: (async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          json: async () => ({ effective, origins: {}, layers: {}, files: {}, workspace: null }),
        } as Response;
      }) as typeof fetch,
    });
    return { urls };
  }

  it("asks the session-less view, because a workspace may not set this field", async () => {
    // SpectroConfig refuses allowLocalhost in a workspace scope (card 199), so
    // a session-scoped read would join layers that cannot answer.
    const seen = serve({ allowLocalhost: true });
    await readLoopbackGate();
    expect(seen.urls).toEqual(["/api/settings"]);
  });

  it("reports the opt-in as the settings resolve it", async () => {
    serve({ allowLocalhost: true });
    expect(await readLoopbackGate()).toBe(true);
    serve({ allowLocalhost: false });
    expect(await readLoopbackGate()).toBe(false);
  });

  it("says nothing rather than false when the field is absent", async () => {
    serve({ provider: "ollama" });
    expect(await readLoopbackGate()).toBeNull();
  });

  it("says nothing rather than false when the read fails", async () => {
    __setTestHooks({
      fetchFn: (async () => {
        throw new Error("no server");
      }) as typeof fetch,
    });
    expect(await readLoopbackGate()).toBeNull();
  });
});

// The wiring, read out of the source. The hook itself needs a React render and
// this suite has no DOM, so what is guarded here is the seam a refactor
// actually breaks: the container asking, and BOTH faces being handed the
// answer. A face left on a literal is the whole defect coming back.
describe("the panel asks, and hands the answer to whichever face renders", () => {
  const source = readFileSync(path.join(__dirname, "BrowserSegment.tsx"), "utf8");

  it("reads the gate once, in the container", () => {
    expect(source).toMatch(/const \w+ = useLoopbackGate\(\);/);
  });

  it("passes it to both faces rather than to one", () => {
    const handed = [...source.matchAll(/allowLocalhost=\{(\w+)\}/g)].map((m) => m[1]);
    expect(handed.length, "a face renders without being told the fence state").toBe(2);
    expect(new Set(handed).size, "the two faces are told different things").toBe(1);
    expect(handed[0], "a face is pinned to a literal").not.toMatch(/^(true|false|null)$/);
  });

  it("renders the composed note at every site that carries the fence class", () => {
    // Two sites today, one per face. A third that hand-typed a sentence would
    // be the card's defect wearing a new address.
    const sites = [...source.matchAll(/className="browser-fence">\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(sites.length, "the fence note left the panel").toBe(2);
    for (const site of sites) {
      expect(site, "a fence line that is not the composed note").toMatch(
        /^fenceNote\(lang, props\.allowLocalhost\)$/,
      );
    }
  });
});

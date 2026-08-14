// What the Web search settings block offers, and whether the thing it offers
// exists (card 203).
//
// The assertion that earns this file is the last one. Criterion 7 of the card
// says the snippet passes a PASTE test, not a review: a command that yields a
// browsable SearXNG the product cannot query is a failure, not a near miss.
// The paste itself was run against a real Docker daemon; what a test can hold
// afterwards is that the command still names a script this repository ships,
// and that the script still contains the one line the whole exercise is about.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DockerStatus } from "./dockerOffer";
import {
  SEARXNG_INSTALL_COMMAND,
  SEARXNG_SAMPLE_PATH,
  WEB_SEARCH_TIERS,
  commitSearxngUrl,
  searxngOffer,
  tierReading,
  webSearchCheck,
  webSearchRowValue,
} from "./webSearchSetup";
import { dict, t } from "../i18n/i18n";

const status = (over: Partial<DockerStatus>): DockerStatus => ({
  docker: "ready",
  compose: true,
  remote: false,
  detail: "",
  ...over,
});

const sample = (name: string): string =>
  fileURLToPath(new URL(`../../../${SEARXNG_SAMPLE_PATH}/${name}`, import.meta.url));

describe("searxngOffer", () => {
  it("hands over the command only when the daemon answers", () => {
    expect(searxngOffer(status({ docker: "ready" })).kind).toBe("run");
    expect(searxngOffer(status({ docker: "ready" })).command).toBe(SEARXNG_INSTALL_COMMAND);
    expect(searxngOffer(status({ docker: "unreachable" })).command).toBeUndefined();
    expect(searxngOffer(status({ docker: "absent" })).command).toBeUndefined();
    expect(searxngOffer(null).command).toBeUndefined();
  });

  it("says SearXNG rather than Langfuse in the two states that name a stack", () => {
    // The state machine is shared with the Observability block on purpose —
    // "is Docker usable here" has one answer per machine, and a second copy of
    // that reasoning would be a second thing to get wrong. What must NOT be
    // shared is the sentence: this block is not offering Langfuse.
    const ready = searxngOffer(status({ docker: "ready" }));
    const absent = searxngOffer(status({ docker: "absent" }));
    expect(ready.messageKey).toBe("set.searxngDockerReady");
    expect(absent.messageKey).toBe("set.searxngDockerAbsent");
    expect(absent.href).toBeDefined();
  });

  it("keeps the shared decisions it does not override", () => {
    expect(searxngOffer(status({ docker: "unreachable" })).kind).toBe("start");
    expect(searxngOffer(status({ docker: "ready", compose: false })).kind).toBe("compose");
    expect(searxngOffer(status({ docker: "ready", remote: true })).kind).toBe("remote");
    expect(searxngOffer(null).kind).toBe("unknown");
  });

  it("the offered command starts the instance and nothing else", () => {
    expect(SEARXNG_INSTALL_COMMAND).toContain(SEARXNG_SAMPLE_PATH);
    expect(SEARXNG_INSTALL_COMMAND).toContain("./install.sh");
    expect(SEARXNG_INSTALL_COMMAND).not.toContain("sudo");
    expect(SEARXNG_INSTALL_COMMAND).not.toContain("| sh");
  });

  it("the command names a setup this repository actually ships, and it turns json on", () => {
    // The drift gate. A command is a promise about a file, so the file is read
    // off the tree this bundle is built from — and read for the ONE line that
    // separates a working paste from a browsable instance the product cannot
    // query. Stock SearXNG answers 403 to format=json until "json" is listed
    // under search.formats; measured against the real image on 2026-08-13.
    expect(existsSync(sample("install.sh"))).toBe(true);
    expect(existsSync(sample("docker-compose.yml"))).toBe(true);

    const installer = readFileSync(sample("install.sh"), "utf8");
    expect(installer.startsWith("#!")).toBe(true);
    expect(installer).toContain("docker compose");
    expect(installer).toContain("formats:");
    expect(installer).toMatch(/^\s*-\s*json\s*$/m);
    // It also has to WAIT for the format to answer, not for the port to open:
    // an instance with json off answers instantly, with 403.
    expect(installer).toContain("format=json");
    // And it hands the address over the way the Langfuse installer does.
    expect(installer).toContain("SPECTRO_SEARXNG_URL");
  });
});

describe("tierReading", () => {
  it("has a sentence in both languages for every tier the resolver can name", () => {
    // The tier names are the server's, so this loop is what keeps a tier added
    // there from arriving here as a blank line. A missing dict entry renders as
    // the bare key, which is exactly the failure this catches.
    for (const tier of WEB_SEARCH_TIERS) {
      const reading = tierReading(tier, "http://box.local:8888");
      expect(dict[reading.detailKey], `${tier}.detailKey`).toBeDefined();
      expect(dict[reading.detailKey].de, `${tier}.de`).toBeTruthy();
      expect(dict[reading.detailKey].en, `${tier}.en`).toBeTruthy();
      if (reading.labelKey !== "") {
        expect(dict[reading.labelKey], `${tier}.labelKey`).toBeDefined();
      }
    }
  });

  it("only the searxng line carries an address, and it really lands in the text", () => {
    const searxng = tierReading("searxng", "http://box.local:8888");
    expect(searxng.addr).toBe("http://box.local:8888");
    for (const lang of ["de", "en"] as const) {
      // A sentence that kept the literal {addr} would be the card-193 failure
      // wearing a placeholder: an address line that names no address.
      expect(t(lang, searxng.detailKey, { addr: searxng.addr })).toContain("http://box.local:8888");
      expect(t(lang, searxng.detailKey, { addr: searxng.addr })).not.toContain("{addr}");
    }
    for (const tier of ["tavily", "brave", "duckduckgo"]) {
      expect(tierReading(tier, "http://box.local:8888").addr).toBe("");
    }
  });

  it("only the scrape gets a label, because only the scrape is nobody's choice", () => {
    expect(tierReading("duckduckgo", "").labelKey).toBe("set.tierLabelScrape");
    for (const tier of ["searxng", "tavily", "brave"]) {
      expect(tierReading(tier, "").labelKey).toBe("");
    }
  });

  it("an unknown tier says nothing rather than something wrong", () => {
    // A newer server naming a tier this bundle has never heard of. Printing a
    // sentence about a different backend would be worse than printing none:
    // the badge still shows the server's word, which is true.
    const reading = tierReading("some-future-tier", "http://box.local:8888");
    expect(reading.detailKey).toBe("");
    expect(reading.labelKey).toBe("");
    expect(reading.addr).toBe("");
  });
});

describe("commitSearxngUrl", () => {
  // Review finding F3. The tier line above the field is the card's criterion 5
  // in the settings surface, and the server computes that tier by READING the
  // settings file the save is still writing. So the re-read has to come after
  // the save has landed, not after a zero-millisecond timer.
  const deferred = (): { promise: Promise<void>; settle: () => void } => {
    let settle = (): void => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  };

  it("re-reads the tier only after the save has landed", async () => {
    const put = deferred();
    const order: string[] = [];
    const save = (): Promise<void> => {
      order.push("save-sent");
      return put.promise.then(() => void order.push("save-landed"));
    };
    const reread = (): void => void order.push("reread");

    const done = commitSearxngUrl("http://box.local:8888", "", save, reread);

    // The save is in flight and the server has not answered. Waiting a REAL
    // interval here is the whole assertion: the version this replaced re-read
    // from a setTimeout(…, 0), and a zero-millisecond macrotask fires long
    // before an HTTP round trip lands. Anything that re-read /api/config now
    // would read the tier from before the write and print the old one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["save-sent"]);

    put.settle();
    await done;
    expect(order).toEqual(["save-sent", "save-landed", "reread"]);
  });

  it("sends null to remove the key and trims what it sends", async () => {
    const patches: Record<string, unknown>[] = [];
    const save = (patch: Record<string, unknown>): void => void patches.push(patch);

    expect(await commitSearxngUrl("  http://box.local:8888  ", "", save, () => {})).toBe(true);
    expect(await commitSearxngUrl("   ", "http://box.local:8888", save, () => {})).toBe(true);
    expect(patches).toEqual([{ searxngUrl: "http://box.local:8888" }, { searxngUrl: null }]);
  });

  it("writes nothing when the field was only visited", async () => {
    // Not just noise: the field is prefilled from the resolved config, which
    // since the F1 fix includes the address the sample installer wrote into
    // ~/.spectro/.env. A write on every blur would copy that into the settings
    // document, where it outranks the file the installer maintains.
    let writes = 0;
    let rereads = 0;
    const wrote = await commitSearxngUrl(
      "  http://box.local:8888 ",
      "http://box.local:8888",
      () => void writes++,
      () => void rereads++,
    );
    expect(wrote).toBe(false);
    expect(writes).toBe(0);
    expect(rereads).toBe(0);
  });
});

// Card 223. The calibration panel drew eight lines and web search was not one of
// them, while /api/config had carried the whole answer since card 203. This is
// the reader that closes the gap — and it is a READER: it takes the served
// payload and chooses a face for it, exactly the way DoctorCommand.webSearchLine
// does on the CLI side. There is no rule here. A rule here would be the third
// copy of a decision card 203 spent a card reducing to one.
describe("webSearchCheck", () => {
  const served = (webSearch: Record<string, string>): { webSearch: Record<string, string> } => ({
    webSearch,
  });

  it("carries the served tier through without deciding anything", () => {
    expect(webSearchCheck(served({ tier: "searxng", searxngUrl: "http://box.local:8888" })).tier).toBe(
      "searxng",
    );
    expect(webSearchCheck(served({ tier: "tavily" })).tier).toBe("tavily");
    expect(webSearchCheck(served({ tier: "brave" })).tier).toBe("brave");
    expect(webSearchCheck(served({ tier: "duckduckgo" })).tier).toBe("duckduckgo");
  });

  it("names the instance address, the way the settings page does", () => {
    // Criterion 3. Same dict entry as the settings block, so the two surfaces
    // cannot end up describing the same instance in different words.
    const check = webSearchCheck(served({ tier: "searxng", searxngUrl: "http://box.local:8888" }));
    expect(check.verdict).toBe("ok");
    for (const lang of ["de", "en"] as const) {
      const line = t(lang, check.reading.detailKey, { addr: check.reading.addr });
      expect(line).toContain("http://box.local:8888");
      expect(line).not.toContain("{addr}");
    }
  });

  it("says best-effort scrape, in the words the failure message uses", () => {
    // Criterion 2, and the whole reason this line is worth drawing. The reader
    // arrives at this panel having just read `duckduckgo answered with a bot
    // check page instead of results — this is the best-effort scrape tier`,
    // thrown by DuckDuckGoSearcher. A line that called the same thing anything
    // else would make them go and look for a second fault.
    const check = webSearchCheck(served({ tier: "duckduckgo" }));
    // Not an error: it is a state to know you are in, not a fault. The CLI
    // makes the same call — Kind.INFO rather than Kind.FAIL.
    expect(check.verdict).toBe("warn");
    for (const lang of ["de", "en"] as const) {
      expect(t(lang, check.reading.detailKey), lang).toContain("best-effort scrape");
    }
  });

  it("a configured tier is quiet, only the scrape is not", () => {
    for (const tier of ["searxng", "tavily", "brave"]) {
      expect(webSearchCheck(served({ tier, searxngUrl: "http://box.local:8888" })).verdict).toBe("ok");
    }
    expect(webSearchCheck(served({ tier: "duckduckgo" })).verdict).toBe("warn");
  });

  it("keeps the panel's three non-answers apart", () => {
    // The panel has to distinguish "not asked yet" from "asked and got
    // nothing", or a slow server reads as a broken one.
    expect(webSearchCheck(null).state).toBe("pending");
    expect(webSearchCheck("failed").state).toBe("failed");
    expect(webSearchCheck("failed").verdict).toBe("error");
    // A server too old to carry the block. The settings page stays silent for
    // this; the doctor may not — silence is the defect this card exists to fix.
    expect(webSearchCheck({}).state).toBe("absent");
    expect(dict["doc.searchNone"], "doc.searchNone").toBeDefined();
  });

  it("shows a future tier's bare name rather than a sentence about the wrong one", () => {
    const check = webSearchCheck(served({ tier: "some-future-tier" }));
    expect(check.state).toBe("tier");
    expect(check.tier).toBe("some-future-tier");
    expect(check.reading.detailKey).toBe("");
  });
});

// The STRING the calibration row shows — the review finding of card 223.
//
// Everything above pins the reader. The row that consults it was pinned by
// nothing: the four-state mapping lived in JSX, and two mutations of it left
// the whole web suite green at 260 files / 3794 tests (measured 2026-08-14).
//
//   value: search.tier                 -> the row reads "duckduckgo", the bare
//                                         word, where criterion 2 wants the
//                                         failure message's own sentence
//   t(lang, search.reading.detailKey)  -> the row reads "searxng — a metasearch
//                                         instance you run, at {addr}" verbatim,
//                                         because t() leaves an uninterpolated
//                                         placeholder standing (i18n.ts:3197),
//                                         and criterion 3's address disappears
//
// Both criteria that make the card worth doing could ship dead. This is the
// shape sessionRowDensity.test.tsx opens by describing from card 214 — a pure
// fold pinned nine ways, and the row that is supposed to consult it pinned by
// nothing — rebuilt one directory over, four cards later.
//
// The mapping is therefore no longer in the component. `renderToStaticMarkup`
// cannot reach this cell's VALUE (the panel fetches in an effect and a server
// render runs none, so the cell stays "…"), so the honest pin for the text is a
// pure function tested here for what it RETURNS.
//
// It cannot be the only pin, and saying it was cost a round. The sentence above
// used to end "…so the honest pin is a pure function", which read as "this
// panel cannot be rendered" — and nothing then asserted the row reached the
// screen at all. `checks.slice(0, 4)` in DoctorPanel.tsx deleted it with tsc
// clean and 3800 tests green. A static render emits every `.doctor-row`; only
// the fetched values are out of reach. doctorPanel.drift.test.tsx now renders
// the panel for the row's presence and holds the row's source to calling this
// function and to holding no other opinion.
describe("webSearchRowValue", () => {
  const served = (webSearch: Record<string, string>): { webSearch: Record<string, string> } => ({
    webSearch,
  });
  const LANGS = ["de", "en"] as const;

  it("shows the tier's sentence and never the bare tier word", () => {
    // Mutation 1, dead here. "duckduckgo" alone is true and useless: it reads
    // like a provider somebody chose, which is the exact misreading card 203's
    // label exists to prevent, on the one surface opened after a search failed.
    const check = webSearchCheck(served({ tier: "duckduckgo" }));
    for (const lang of LANGS) {
      const value = webSearchRowValue(check, lang);
      expect(value, lang).not.toBe(check.tier);
      expect(value, lang).toBe(t(lang, "set.tier.duckduckgo"));
      expect(value, lang).toContain("best-effort scrape");
    }
  });

  it("interpolates the instance address and leaves no placeholder standing", () => {
    // Mutation 2, dead here. t() replaces what it is given and passes the rest
    // through untouched, so a dropped argument does not throw and does not
    // blank the row — it prints "{addr}" at the reader, in a row whose entire
    // purpose in this state is to name that address.
    const check = webSearchCheck(served({ tier: "searxng", searxngUrl: "http://box.local:8888" }));
    for (const lang of LANGS) {
      const value = webSearchRowValue(check, lang);
      expect(value, lang).toContain("http://box.local:8888");
      expect(value, lang).not.toMatch(/\{[a-z]+\}/i);
    }
  });

  it("leaves no placeholder standing in any tier's sentence", () => {
    // The guard above, generalised: whatever a future tier's sentence needs
    // interpolated, this function is the one place that can forget to pass it.
    for (const tier of WEB_SEARCH_TIERS) {
      const check = webSearchCheck(served({ tier, searxngUrl: "http://box.local:8888" }));
      for (const lang of LANGS) {
        expect(webSearchRowValue(check, lang), `${tier}/${lang}`).not.toMatch(/\{[a-z]+\}/i);
      }
    }
  });

  it("keeps the three non-answers apart and translates each of them", () => {
    for (const lang of LANGS) {
      expect(webSearchRowValue(webSearchCheck(null), lang), lang).toBe("…");
      expect(webSearchRowValue(webSearchCheck("failed"), lang), lang).toBe(t(lang, "doc.unreachable"));
      expect(webSearchRowValue(webSearchCheck({}), lang), lang).toBe(t(lang, "doc.searchNone"));
    }
    // "not asked yet" may not read as "broken", and neither may borrow the
    // other's words.
    expect(webSearchRowValue(webSearchCheck(null), "en")).not.toBe(
      webSearchRowValue(webSearchCheck("failed"), "en"),
    );
  });

  it("prints a future tier's bare name rather than a sentence about the wrong one", () => {
    // The one state where the bare word is the right answer: a newer server
    // named a tier this bundle has no sentence for. True beats fluent.
    const check = webSearchCheck(served({ tier: "some-future-tier" }));
    for (const lang of LANGS) {
      expect(webSearchRowValue(check, lang), lang).toBe("some-future-tier");
    }
  });
});

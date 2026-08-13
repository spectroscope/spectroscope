// Chrome localisation: every dict entry carries BOTH languages, t() fills
// placeholders, and unknown keys pass through loudly (they render as the key).
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";
import { DENSITIES } from "../state/density";
import { LAB_FACES } from "../state/labFace";
import { SOURCE_NOTE_KINDS } from "../import/sourceNotes";
import { COPY_LABELS, READINGS, SOURCE_PANE_KINDS, sourceSentence } from "../components/traceDetail";
import type { SourcePane } from "../components/traceDetail";
import { HIDDEN_KINDS } from "../components/readable";
import { CATEGORIES } from "../components/TraceView";
import { TODO_STATUSES } from "../components/todoList";
import { TRACE_FACES } from "../state/traceFace";
import { dockerOffer, type DockerStatus } from "../components/dockerOffer";
import { searxngOffer } from "../components/webSearchSetup";

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
    // The same three statuses again, in their counting form (card 141). Two
    // families rather than one because a badge labels a single item and a
    // count follows a number: German says "läuft …" for the first and needs
    // "in Arbeit" for the second, and one family would have shipped the wrong
    // half of that. Reached only as `trace.todo.${status}`.
    for (const p of TODO_STATUSES) {
      expect(dict[`trace.todo.${p}`], `trace.todo.${p}`).toBeDefined();
    }
    // A workflow run's headline row: the labels are reached only as
    // `tv.run.${RunStat["key"]}`, so a stat added without its word would ship as
    // the bare key in the one place a reader counts dead agents.
    for (const k of ["agents", "failed", "skipped", "empty", "tokens", "tools", "elapsed"]) {
      expect(dict[`tv.run.${k}`], `tv.run.${k}`).toBeDefined();
    }
    // The session list's density (card 214). Both the value's word and its hint
    // are reached only as `dens.${Density}`, so a third value added to the store
    // without its strings would print the bare key inside the one panel the rail
    // has. The panel's own two labels are asserted alongside them.
    for (const d of DENSITIES) {
      expect(dict[`dens.${d}`], `dens.${d}`).toBeDefined();
      expect(dict[`dens.${d}.hint`], `dens.${d}.hint`).toBeDefined();
    }
    for (const k of ["sess.opts", "dens.title"]) {
      expect(dict[k], k).toBeDefined();
    }
    // The trace's faces are interpolated twice: as the master switch's buttons
    // and titles, and as the open frame's own row of modes. A face added to the
    // store without its strings would render as the bare key.
    for (const f of TRACE_FACES) {
      expect(dict[`trace.mode.${f}`], `trace.mode.${f}`).toBeDefined();
      expect(dict[`trace.faceTitle.${f}`], `trace.faceTitle.${f}`).toBeDefined();
    }
    // The lab's tool-panel faces (card 120): the master seg and the panel strip
    // interpolate the shared face labels plus a lab title per face; the seg
    // itself carries a label, an aria name and a hint.
    for (const f of LAB_FACES) {
      expect(dict[`trace.mode.${f}`], `trace.mode.${f}`).toBeDefined();
      expect(dict[`lab.faceTitle.${f}`], `lab.faceTitle.${f}`).toBeDefined();
    }
    for (const k of ["lab.face", "lab.faceAria", "lab.faceHint"]) {
      expect(dict[k], k).toBeDefined();
    }
    // The trace's type chips. They render from the dict now rather than from
    // the enum's own spelling, so a category added without its word would show
    // up as the bare key in the one row a reader filters with. The nine that
    // were there before carry the same lowercase word in both languages,
    // because that word IS the wire vocabulary (trace.lens and trace.timeline
    // are spelled the same way for the same reason).
    for (const c of CATEGORIES) {
      expect(dict[`trace.cat.${c}`], `trace.cat.${c}`).toBeDefined();
    }
    // What an imported line says beyond its frames: the chip carries a word and
    // the tooltip carries the sentence that keeps the word from being a riddle.
    // Both are reached only as `trace.note.${kind}`.
    for (const k of SOURCE_NOTE_KINDS) {
      expect(dict[`trace.note.${k}`], `trace.note.${k}`).toBeDefined();
      expect(dict[`trace.note.${k}Title`], `trace.note.${k}Title`).toBeDefined();
    }
    // The source pane's cases. Each one is a whole sentence, because each is a
    // different statement about where the frame came from, and a pane that fell
    // back to a shared word for two of them would be this card's own defect.
    // Walked through the CHOOSER rather than over the kinds alone, because the
    // sentence is not one per kind: a translation gives the "none" case a second
    // one, since the byte-for-byte half of the first stops being true. Anything
    // the chooser can return has to exist, or the pane prints the key.
    for (const k of SOURCE_PANE_KINDS) {
      for (const translated of [false, true]) {
        const key = sourceSentence({ kind: k } as SourcePane, translated);
        expect(dict[key], key).toBeDefined();
      }
    }
    // Both reasons the readable pane collapses a value. They render the same
    // control and say different things, and one sentence for both is how a
    // 3424 character dictated prompt came to be called "characters that are not
    // text". A kind added to HIDDEN_KINDS with no sentence of its own would
    // fall back to the other one's claim, which is the defect, not a gap.
    for (const k of HIDDEN_KINDS) {
      expect(dict[`trace.source.${k}`], `trace.source.${k}`).toBeDefined();
    }
    for (const k of [
      "trace.source.shared",
      "trace.source.notJson",
      "trace.source.capped",
      "trace.source.showAll",
      // One ceiling, two escapes: the structured face's copy button hands over
      // the payload, so it cannot borrow the source pane's promise about the
      // line. A missing sentence here would fall back to that promise.
      "trace.meta.capped",
      // What it is and how much of it there is, plus the two words that open and
      // close it. Dropping a collapsed value silently would be a hole the reader
      // cannot see, so it is always three visible strings.
      "trace.source.show",
      "trace.source.hide",
    ]) {
      expect(dict[k], k).toBeDefined();
    }
    // The verbatim/readable strip inside the source and wire panes: a label and
    // the tooltip that says which of the two is the file's own bytes.
    for (const r of READINGS) {
      expect(dict[`trace.reading.${r}`], `trace.reading.${r}`).toBeDefined();
      expect(dict[`trace.readingTitle.${r}`], `trace.readingTitle.${r}`).toBeDefined();
    }
    expect(dict["trace.readingAria"], "trace.readingAria").toBeDefined();
    // The copy button names which of the two it took, reached as
    // `common.${copyLabel(...)}`.
    for (const k of COPY_LABELS) {
      expect(dict[`common.${k}`], `common.${k}`).toBeDefined();
    }
    // The reasoning seg (card 88): every string the shared control renders.
    // A missing key ships as its bare name — it happened twice this week.
    for (const k of [
      "rc.label",
      "rc.aria",
      "rc.on",
      "rc.off",
      "rc.onTitle",
      "rc.offTitle",
      "rc.clearTitle",
      "rc.effortTitle",
      "rc.offCap",
      "rc.noOff",
      "rc.noneThinks",
      "rc.noneQuiet",
      "rc.settingsLabel",
      "rc.settingsNote",
    ]) {
      expect(dict[k], k).toBeDefined();
    }
    // Docker detection (card 137): the message key is DERIVED from the offer,
    // so a new Docker state that nobody wrote copy for goes red here instead of
    // shipping its own key name as the sentence the operator reads.
    const dockerStates: (DockerStatus | null)[] = [null];
    for (const docker of ["absent", "unreachable", "ready"] as const) {
      for (const compose of [true, false]) {
        for (const remote of [true, false]) {
          dockerStates.push({ docker, compose, remote });
        }
      }
    }
    for (const state of dockerStates) {
      const key = dockerOffer(state).messageKey;
      expect(dict[key], key).toBeDefined();
    }
    for (const k of ["set.dockerInstall", "set.langfuseCommand", "set.langfuseCost"]) {
      expect(dict[k], k).toBeDefined();
    }
    // Web search (card 203) rides the SAME derived-key rule, over the same
    // states: the block overrides two of Docker's sentences and inherits the
    // rest, so a state whose SearXNG copy was never written goes red here
    // rather than printing "set.searxngDockerReady" at an operator.
    for (const state of dockerStates) {
      const key = searxngOffer(state).messageKey;
      expect(dict[key], key).toBeDefined();
    }
    for (const k of [
      "set.secWebSearch",
      "set.webSearchHint",
      "set.searxngUrl",
      "set.searxngOwnInstance",
      "set.searxngCost",
      "set.searchKeyedHint",
      "set.tavilyKey",
      "set.braveKey",
      "set.searchKeyPlaceholder",
      "set.searchKeyReplace",
      "set.searchKeyPresent",
      "set.searchKeyAbsent",
      "set.searchScrapeNote",
      "set.searchNoFallThrough",
    ]) {
      expect(dict[k], k).toBeDefined();
    }
  });
});

// The import bar's own sentence. Card 141 opened on the owner reading it and
// asking whether the importer had a parsing bug: "21 lines produced no frame"
// describes deliberate behaviour in the vocabulary of failure. The bar was
// right and the importer was right; only the wording was wrong.
describe("the import bar says what it means", () => {
  it("no longer reports design as a defect, in either language", () => {
    expect(dict["imp.bar"].en).not.toMatch(/produced no frame/);
    expect(dict["imp.bar"].de).not.toMatch(/keinen Frame erzeugt/);
  });

  // Card 152. "110 lines carry no conversation" was a claim about the FILE,
  // and it was false: those 110 lines held a whole conversation, and the
  // importer could not attribute them. The count is a measurement of what this
  // importer read, so the sentence has to say that and not describe somebody
  // else's file as empty.
  it("says what was read rather than what the file contains", () => {
    expect(dict["imp.bar"].en).not.toMatch(/carry no conversation/);
    expect(dict["imp.bar"].de).not.toMatch(/tragen kein Gespräch/);
    expect(dict["imp.bar"].en).toMatch(/read/);
    expect(dict["imp.bar"].de).toMatch(/gelesen/);
  });

  it("names a subagent transcript for what it is, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      expect(dict["imp.subagent"][lang]).toContain("{agent}");
      expect(dict["imp.subagentSession"][lang]).toContain("{session}");
      expect(dict["imp.subagentKind"][lang]).toContain("{kind}");
    }
  });

  it("still names all three counts, so the sentence stays checkable", () => {
    for (const lang of ["de", "en"] as const) {
      for (const slot of ["{file}", "{lines}", "{frames}", "{zero}"]) {
        expect(dict["imp.bar"][lang], `${lang} ${slot}`).toContain(slot);
      }
    }
  });
});

// Card 193 gave ollama and LM Studio addresses of their own, which demoted the
// shared baseUrl to a fallback. The workspace gear's description was written
// before that and still called it "the address for ollama and OpenAI-compatible
// providers" — a sentence that sends someone to the wrong field and then leaves
// them wondering why their remote box is not being dialled.
describe("the workspace gear describes baseUrl as what it now is", () => {
  it("does not claim to be ollama's address, in either language", () => {
    expect(dict["wsg.local.desc.baseUrl"].en).not.toMatch(/^The address for ollama/);
    expect(dict["wsg.local.desc.baseUrl"].de).not.toMatch(/^Die Adresse für ollama/);
  });

  it("names the two fields that outrank it, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const desc = dict["wsg.local.desc.baseUrl"][lang];
      expect(desc, `${lang} names ollamaBaseUrl`).toContain("ollamaBaseUrl");
      expect(desc, `${lang} names lmstudioBaseUrl`).toContain("lmstudioBaseUrl");
    }
  });
});

// The browser segment's fence note (card 201, review finding 4). The settings
// text used to promise a fence that a redirect walked around: with the loopback
// opt-in OFF, a 302 to a public name resolving to 127.0.0.1 loaded and titled
// itself PWNED. The hole is closed; what is still outside anybody's reach has to
// be where the OPERATOR reads it, not only in a source comment.
describe("the browser segment states the fence, and its limit", () => {
  it("names the opt-in and the redirect hop, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const note = dict["browser.fenceNote"][lang];
      expect(note, `${lang} names the opt-in`).toContain("allowLocalhost");
      expect(note, `${lang} names file://`).toContain("file://");
      expect(note.length, `${lang} says something`).toBeGreaterThan(80);
    }
  });

  it("admits what no fence catches rather than only what it blocks", () => {
    expect(dict["browser.fenceNote"].en).toMatch(/DNS answer that changes/);
    expect(dict["browser.fenceNote"].de).toMatch(/DNS-Antwort, die sich/);
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

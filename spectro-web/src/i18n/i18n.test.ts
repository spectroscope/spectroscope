// Chrome localisation: every dict entry carries BOTH languages, t() fills
// placeholders, and unknown keys pass through loudly (they render as the key).
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";
import { DENSITIES } from "../state/density";
import { LAB_FACES } from "../state/labFace";
import { SOURCE_NOTE_KINDS } from "../import/sourceNotes";
import { degradeKey, RUN_DEGRADE_REASONS } from "../import/storeDoor";
import { COPY_LABELS, READINGS, SOURCE_PANE_KINDS, sourceSentence } from "../components/traceDetail";
import type { SourcePane } from "../components/traceDetail";
import { HIDDEN_KINDS } from "../components/readable";
import { PROVIDERS } from "../components/providerPickerMode";
import { addressSpecFor } from "../components/providerAddress";
import { CATEGORIES } from "../components/TraceView";
import { TODO_STATUSES } from "../components/todoList";
import { TRACE_FACES } from "../state/traceFace";
import { dockerOffer, type DockerStatus } from "../components/dockerOffer";
import { searxngOffer } from "../components/webSearchSetup";
import { hookReadingKey, timeoutNoteKey } from "../components/hooksSetup";
import { SETTINGS_TABS, settingsTabLabelKey } from "../components/settingsTabs";

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
    // What a write DID to the file (card 269). Reached only as
    // `tv.change.${FileChange}`, so the one chip that tells an operator his
    // agent is writing the same bytes over and over would otherwise ship as
    // the bare key — in the exact situation where nobody is reading closely.
    for (const c of ["created", "changed", "unchanged"]) {
      expect(dict[`tv.change.${c}`], `tv.change.${c}`).toBeDefined();
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
    // The settings rooms (card 256). Reached only as `set.tab.${SettingsTab}`,
    // so a seventh room added to the grouping table without its two words would
    // print the bare key across the top of the panel.
    for (const tab of SETTINGS_TABS) {
      expect(dict[settingsTabLabelKey(tab)], settingsTabLabelKey(tab)).toBeDefined();
    }
    expect(dict["set.tabs"], "set.tabs").toBeDefined();
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
    // Card 318. Why a run load came back as the session file alone: too big,
    // the server did not answer, the agents are not there any more. Each is a
    // different fact and each owes the reader its own sentence, reached only as
    // `imp.run.<code>` — so a fourth reason without a word is red here rather
    // than printing its own key at the reader.
    for (const reason of RUN_DEGRADE_REASONS) {
      expect(dict[degradeKey(reason)], degradeKey(reason)).toBeDefined();
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
    // Hooks (card 195), on the same derived-key rule. Both clause families are
    // reached only through hooksSetup, never spelled at a call site, so a phase
    // or a timeout case whose sentence nobody wrote would print its own key name
    // beside a command this product executes.
    for (const event of ["pre_tool_use", "post_tool_use"]) {
      for (const timeoutSeconds of [null, 3]) {
        const entry = {
          event,
          matcher: "*",
          rawMatcher: null,
          command: "x.sh",
          redactionRule: "",
          timeoutSeconds,
          effectiveTimeoutSeconds: 10,
        };
        expect(dict[hookReadingKey(entry)], hookReadingKey(entry)).toBeDefined();
        expect(dict[timeoutNoteKey(entry)], timeoutNoteKey(entry)).toBeDefined();
      }
    }
    for (const k of [
      "set.secHooks",
      "set.hkHint",
      "set.hkTierNote",
      "set.hkScopeUser",
      "set.hkScopeOther",
      "set.hkEmpty",
      "set.hkBeforeGate",
      "set.hkWillRedact",
      "set.hkInForce",
      "set.hkReachSession",
      "set.hkReachProcess",
      "set.hkNoneInForce",
      "set.hkFromLayer",
      "set.hkShadowed",
      "set.hkInForceTag",
      "set.hkSilencedTag",
      "set.hkEvent",
      "set.hkMatcher",
      "set.hkCommand",
      "set.hkTimeout",
      "set.hkPreview",
      "set.hkAdd",
      "set.hkRemove",
      "set.hkApplies",
      "set.hkFailOpen",
      "set.hkLoadFailed",
    ]) {
      expect(dict[k], k).toBeDefined();
    }
  });
});

// Card 195. The hooks block says two things a settings page would normally not
// bother with, and both were measured out of the engine before they were
// written. Leaving either out does not make the page vaguer, it makes it wrong:
// the card's own AC 2 asked for "reaches the next run without a restart", and
// the server resolves a session's hooks ONCE, in buildAgentOnce.
describe("the hooks block does not promise more than the engine does", () => {
  it("says a change lands on the next session, not on the running one", () => {
    expect(dict["set.hkApplies"].en).toMatch(/next session/);
    expect(dict["set.hkApplies"].en).toMatch(/already open/);
    expect(dict["set.hkApplies"].de).toMatch(/nächsten Sitzung/);
    expect(dict["set.hkApplies"].de).toMatch(/offene Sitzung/);
  });

  it("says a hook that timed out let the call through, in both languages", () => {
    // The one an operator would otherwise learn the hard way. HookRunner fails
    // open on purpose, so a page implying that a configured guard always answers
    // would be describing a fence with a gap in it.
    expect(dict["set.hkFailOpen"].en).toMatch(/proceeds anyway/);
    expect(dict["set.hkFailOpen"].en).toMatch(/timed-out/);
    expect(dict["set.hkFailOpen"].de).toMatch(/trotzdem/);
    expect(dict["set.hkFailOpen"].de).toMatch(/timed-out/);
  });

  it("says a layer that sets hooks REPLACES the ones below, in both languages", () => {
    // The sentence the review's blocking finding turned on. `hooks` is a
    // whole-block field, and the block's old wording — "From {scope} —
    // read-only here." — reads as additive, so a reader adds the lists up and
    // believes in guards a higher layer already replaced.
    expect(dict["set.hkShadowed"].en).toMatch(/replaced whole/);
    expect(dict["set.hkShadowed"].en).toMatch(/does not add/);
    expect(dict["set.hkShadowed"].de).toMatch(/komplett ersetzt/);
    expect(dict["set.hkShadowed"].de).toMatch(/nicht .* hinzu/);
  });

  it("does not pass a machine-wide answer off as a description of a run", () => {
    // Without a session id the workspace layers never join the chain. A page
    // that says "what runs" over that list, with a session open beside it whose
    // workspace replaced the whole block, is confidently wrong — which is what
    // it was.
    expect(dict["set.hkReachProcess"].en).toMatch(/No session is running/);
    expect(dict["set.hkReachProcess"].en).toMatch(/replace this list whole/);
    expect(dict["set.hkReachProcess"].de).toMatch(/keine Sitzung/);
    expect(dict["set.hkReachProcess"].de).toMatch(/als Ganzes/);
  });

  it("names the permission gate the pre phase runs ahead of, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      expect(dict["set.hkTierNote"][lang]).toMatch(/pre_tool_use/);
    }
    expect(dict["set.hkTierNote"].en).toMatch(/permission gate/);
    expect(dict["set.hkTierNote"].de).toMatch(/Berechtigungs-Dialog/);
  });

  it("keeps the placeholders its two counted sentences interpolate", () => {
    for (const lang of ["de", "en"] as const) {
      expect(dict["set.hkTimeoutOwn"][lang], `${lang} {sec}`).toContain("{sec}");
      expect(dict["set.hkTimeoutInherited"][lang], `${lang} {sec}`).toContain("{sec}");
      expect(dict["set.hkTimeout"][lang], `${lang} {sec}`).toContain("{sec}");
      expect(dict["set.hkWillRedact"][lang], `${lang} {rule}`).toContain("{rule}");
      expect(dict["set.hkScopeOther"][lang], `${lang} {scope}`).toContain("{scope}");
      expect(dict["set.hkFromLayer"][lang], `${lang} {scope}`).toContain("{scope}");
      expect(dict["set.hkSilencedTag"][lang], `${lang} {scope}`).toContain("{scope}");
      expect(dict["set.hkReachSession"][lang], `${lang} {ws}`).toContain("{ws}");
      expect(dict["set.hkShadowed"][lang], `${lang} {scopes}`).toContain("{scopes}");
      expect(dict["set.hkShadowed"][lang], `${lang} {scope}`).toContain("{scope}");
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

  // Card 312 added a THIRD provider with its own address and the same
  // precedence, and this guard was left naming two of them — so the sentence
  // could keep saying "only applies to those two" with a green suite behind
  // it. The list is no longer typed out here: it is DERIVED from the picker's
  // providers and the address spec each one owns, so a fourth field cannot be
  // added without this sentence being asked about it.
  it("names every per-provider address field that outranks it, in both languages", () => {
    const owned = PROVIDERS.map((p) => addressSpecFor(p)?.field).filter((f) => f !== undefined);
    expect(owned.length, "no provider owns an address field any more").toBeGreaterThan(0);
    for (const lang of ["de", "en"] as const) {
      const desc = dict["wsg.local.desc.baseUrl"][lang];
      for (const field of owned) {
        expect(desc, `${lang} names ${field}`).toContain(field);
      }
    }
  });
});

// Card 312, round 3. The addressless "backend not reachable" sentence is the
// fallback an OLD server triggers, for WHICHEVER local provider is selected —
// and it named two products by hand, so it went stale the day a third local
// backend arrived and would have told a llama.cpp operator to start LM Studio.
// The specific sentence beside it (pp.localDownAt) names the ADDRESS, which is
// a fact the server reports; the generic one may name no product at all.
describe("the addressless unreachable sentence names no backend", () => {
  it("mentions no provider that owns an address, in either language", () => {
    const owners = PROVIDERS.filter((p) => addressSpecFor(p) !== null);
    expect(owners.length, "no provider owns an address any more").toBeGreaterThan(0);
    for (const lang of ["de", "en"] as const) {
      // "LM Studio" and "llama.cpp" are the same names with punctuation in
      // them, so the comparison is made on letters only.
      const letters = dict["pp.localDown"][lang].toLowerCase().replace(/[^a-z]/g, "");
      for (const owner of owners) {
        expect(letters, `${lang} names "${owner}", and the reader may be running another`).not.toContain(
          owner.replace(/[^a-z]/g, ""),
        );
      }
    }
  });
});

// Card 222. The defect was a settings page that reported a state the run did
// not have, and said nothing about which of the two it was describing. The fix
// is that every saveable setting carries a sentence about WHEN it lands, so
// these two sentences are load-bearing UI, not decoration — a build that keeps
// the keys but empties the promise out of them is the silence coming back.
describe("the settings page says when a change reaches the run", () => {
  it("promises the open session, not just the next one", () => {
    expect(dict["set.reachLive"].en).toMatch(/already open/);
    expect(dict["set.reachLive"].en).toMatch(/next tool call/);
    expect(dict["set.reachLive"].de).toMatch(/offene Sitzung/);
    expect(dict["set.reachLive"].de).toMatch(/Tool-Aufruf/);
  });

  it("has the other half of the answer, and names the door that IS live", () => {
    // The review's F1. This sentence exists because the live one was written
    // under the provider grid, where it was measured to be false: settings
    // written to model=qwen3:latest, /api/config agreeing, and the next run in
    // the same session still on the old model. Saying only "next session"
    // would leave a reader who wants to switch NOW with nowhere to go, so the
    // picker is named in the same breath.
    expect(dict["set.provApplies"].en).toMatch(/next session/);
    expect(dict["set.provApplies"].en).toMatch(/picker/);
    expect(dict["set.provApplies"].de).toMatch(/nächsten Sitzung/);
    expect(dict["set.provApplies"].de).toMatch(/Umschalter/);
    // The GENERIC one names no field at all. Read live at 127.0.0.1:8391, the
    // first draft named the provider and was rendering under the OTLP pair —
    // a sentence shared by several blocks may only say what they share.
    expect(dict["set.reachNextSession"].en).toMatch(/next session/);
    expect(dict["set.reachNextSession"].en).not.toMatch(/provider|model|address|picker/);
    expect(dict["set.reachNextSession"].de).not.toMatch(/Provider|Modell|Adresse|Umschalter/);
  });

  it("says the allowlist is the exception, and why", () => {
    // "Next session" alone reads as an oversight next to four blocks that say
    // "immediately". The reason is what turns it into a decision a reader can
    // agree with: a run that can write files must not be able to widen its own
    // permissions between two tool calls.
    expect(dict["set.alApplies"].en).toMatch(/next session/);
    expect(dict["set.alApplies"].en).toMatch(/write files/);
    expect(dict["set.alApplies"].de).toMatch(/nächsten Sitzung/);
    expect(dict["set.alApplies"].de).toMatch(/Dateien schreiben/);
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

// Card 204: the replay. Both languages, every key — and two sentences carry
// facts the reader acts on, so they are checked for saying them rather than for
// merely existing. The empty state must name BOTH ways of having no record
// (never drove one / it was deleted), because otherwise a reader whose record
// was deleted concludes the feature is broken. And the fence note must say what
// the record does not carry, since that is the promise the card was written on.
describe("the browser replay says what it is and what it is not", () => {
  const keys = [
    "browser.replay.title",
    "browser.replay.loading",
    "browser.replay.emptyTitle",
    "browser.replay.empty",
    "browser.replay.emptyHint",
    "browser.replay.noPage",
    "browser.replay.browserLabel",
    "browser.replay.browserN",
    "browser.replay.stepN",
    "browser.replay.prev",
    "browser.replay.next",
    "browser.replay.scrubber",
    "browser.replay.shotAlt",
    "browser.replay.shotAt",
    "browser.replay.noShotYet",
    "browser.replay.held",
    "browser.replay.detailGone",
    "browser.replay.ceiling",
    "browser.replay.stillOpen",
    "browser.replay.redacted",
    "browser.replay.note",
  ];

  it("has every key in both languages", () => {
    for (const key of keys) {
      expect(dict[key], key).toBeTruthy();
      expect(dict[key].en.trim(), `${key} en`).not.toBe("");
      expect(dict[key].de.trim(), `${key} de`).not.toBe("");
    }
  });

  it("keeps its interpolation slots in both languages", () => {
    // A dropped {n} is silent: t() simply leaves the sentence without the
    // number, and "Step of" reads as a typo rather than as a missing fact.
    expect(dict["browser.replay.stepN"].en).toContain("{n}");
    expect(dict["browser.replay.stepN"].de).toContain("{n}");
    expect(dict["browser.replay.stepN"].en).toContain("{count}");
    expect(dict["browser.replay.stepN"].de).toContain("{count}");
    expect(dict["browser.replay.browserN"].en).toContain("{n}");
    expect(dict["browser.replay.browserN"].de).toContain("{n}");
    expect(dict["browser.replay.redacted"].en).toContain("{rule}");
    expect(dict["browser.replay.redacted"].de).toContain("{rule}");
    expect(dict["browser.replay.shotAt"].en).toContain("{w}");
    expect(dict["browser.replay.shotAt"].de).toContain("{h}");
  });

  it("names both ways of having no record, so an empty pane is not read as a bug", () => {
    expect(dict["browser.replay.empty"].en).toMatch(/drove no browser/);
    expect(dict["browser.replay.empty"].en).toMatch(/deleted/);
    expect(dict["browser.replay.empty"].de).toMatch(/keinen Browser gefahren/);
    expect(dict["browser.replay.empty"].de).toMatch(/gel\u00f6scht/);
  });

  it("states what the record does not carry", () => {
    expect(dict["browser.replay.note"].en).toMatch(/cookies/i);
    expect(dict["browser.replay.note"].en).toMatch(/never enter/);
    expect(dict["browser.replay.note"].de).toMatch(/Cookies/);
    expect(dict["browser.replay.note"].de).toMatch(/nie hinein/);
  });
});

// Card 226: the web face's live view. Criterion 5 is a sentence, not a state —
// one browser per session means the segment must SAY whose picture it shows,
// and the one-per-session rule itself must be readable where the desktop pane
// preempts this surface. Both languages, because the face label is the single
// word a reader decides by.
describe("the web face's view says whose browser is live", () => {
  const keys = [
    "browser.view.faceWeb",
    "browser.view.faceDesktop",
    "browser.view.faceNone",
    "browser.view.faceTitle",
    "browser.view.back",
    "browser.view.forward",
    "browser.view.reload",
    "browser.view.screenshot",
    "browser.view.address",
    "browser.view.addressHint",
    "browser.view.idleNote",
    "browser.view.desktopLiveNote",
    "browser.view.pictureLabel",
  ];

  it("has every key in both languages", () => {
    for (const key of keys) {
      expect(dict[key], key).toBeTruthy();
      expect(dict[key].en.trim(), `${key} en`).not.toBe("");
      expect(dict[key].de.trim(), `${key} de`).not.toBe("");
    }
  });

  it("names the one-per-session rule where the pane preempts this surface", () => {
    expect(dict["browser.view.desktopLiveNote"].en).toMatch(/one browser per session/);
    expect(dict["browser.view.desktopLiveNote"].en).toMatch(/desktop/i);
    expect(dict["browser.view.desktopLiveNote"].de).toMatch(/ein Browser pro Session/);
    expect(dict["browser.view.desktopLiveNote"].de).toMatch(/Desktop/);
  });

  it("tells the keyboard reader which keys stay with the app", () => {
    // Tab and Escape are deliberately NOT forwarded to the page (the picture
    // must never trap the keyboard); the label is where that promise is made.
    expect(dict["browser.view.pictureLabel"].en).toMatch(/Tab and Escape/);
    expect(dict["browser.view.pictureLabel"].de).toMatch(/Tab und Escape/);
  });
});

// Card 218: the browser belongs to a session, and the two states that are new
// because of it have to say so in both languages — a reader who sees an empty
// frame and no sentence reads a bug, and a reader told "no browser" without
// being told whose browser learns nothing.
describe("the browser segment says whose browser it is", () => {
  it("explains the session that has no id yet, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const note = dict["browser.noSessionNote"][lang];
      expect(note.length, `${lang} says something`).toBeGreaterThan(60);
    }
    // Card 228 (criterion 8) retired the deck voice here: the sentence names
    // the two things a person can DO — send a message, or press a launch
    // configuration — instead of explaining session ownership philosophy.
    expect(dict["browser.noSessionNote"].en).toMatch(/first message/);
    expect(dict["browser.noSessionNote"].de).toMatch(/erste Nachricht/);
    expect(dict["browser.noSessionNote"].en).toMatch(/[Ll]aunch/);
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

// Card 228 (criterion 9): the register guard. UI copy on empty states,
// placeholders and footer notes is terse and technical — what it is, why it
// is empty, what to do next. The house voice lives in cards and docs, never
// in an empty state. The cheap pin against drifting back: no such string
// grows past 200 characters in either language without a named exemption
// here that says which card blessed it.
describe("the empty-state register stays terse (card 228)", () => {
  // Footer and hint-bar keys that do not match the name pattern but carry
  // the same register duty — the sweep's named specimens live here.
  const footnotes = ["browser.fenceNote", "browser.replay.note", "sg.claim", "sg.empty.pair"];
  const exempt: Record<string, string> = {
    // none today — an entry here names the card that allowed it
  };

  it("keeps every empty-state, idle, placeholder and footer string under 200 chars", () => {
    const keys = Object.keys(dict).filter(
      (k) => /(\.empty|\.no[A-Z]|\.idle|idleNote|placeholder)/.test(k) || footnotes.includes(k),
    );
    // The net must actually catch the surfaces — if the naming pattern rots,
    // this fails loudly instead of guarding nothing.
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      if (key in exempt) continue;
      for (const lang of ["de", "en"] as const) {
        expect(
          dict[key][lang].length,
          `${key}.${lang} is ${dict[key][lang].length} chars — terse register, or a named exemption`,
        ).toBeLessThanOrEqual(200);
      }
    }
  });
});

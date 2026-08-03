// Chrome localisation: every dict entry carries BOTH languages, t() fills
// placeholders, and unknown keys pass through loudly (they render as the key).
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";
import { LAB_FACES } from "../state/labFace";
import { SOURCE_NOTE_KINDS } from "../import/sourceNotes";
import { COPY_LABELS, READINGS, SOURCE_PANE_KINDS } from "../components/traceDetail";
import { TRACE_FACES } from "../state/traceFace";
import { dockerOffer, type DockerStatus } from "../components/dockerOffer";

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
    // A workflow run's headline row: the labels are reached only as
    // `tv.run.${RunStat["key"]}`, so a stat added without its word would ship as
    // the bare key in the one place a reader counts dead agents.
    for (const k of ["agents", "failed", "skipped", "empty", "tokens", "tools", "elapsed"]) {
      expect(dict[`tv.run.${k}`], `tv.run.${k}`).toBeDefined();
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
    // What an imported line says beyond its frames: the chip carries a word and
    // the tooltip carries the sentence that keeps the word from being a riddle.
    // Both are reached only as `trace.note.${kind}`.
    for (const k of SOURCE_NOTE_KINDS) {
      expect(dict[`trace.note.${k}`], `trace.note.${k}`).toBeDefined();
      expect(dict[`trace.note.${k}Title`], `trace.note.${k}Title`).toBeDefined();
    }
    // The source pane's four cases. Each one is a whole sentence, because each
    // is a different statement about where the frame came from, and a pane that
    // fell back to a shared word for two of them would be this card's own
    // defect. The shared-line sentence is the fifth string: it is the "line"
    // case when one line produced several frames.
    for (const k of SOURCE_PANE_KINDS) {
      expect(dict[`trace.source.${k}`], `trace.source.${k}`).toBeDefined();
    }
    for (const k of [
      "trace.source.shared",
      "trace.source.notJson",
      "trace.source.capped",
      "trace.source.showAll",
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

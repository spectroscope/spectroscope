// Card 482, fix round: the run view names the end a run reached and the stop
// reason, each for what it is.
//
// Measured 2026-10-10 in the live check (kanban/evidence/482/E2E.md, runs 1
// and 3): playbook_end carried stopReason "done" and result "cancelled", and
// the view said "The run ended: done". The stop reason says how the runner
// stopped (done: the path reached one of its ends); the result is the label
// of that end. A cancelled end reached cleanly is still a cancelled run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dict, t } from "../i18n/i18n";
import type { PlaybookRunRow } from "../state/playbookRuns";
import { runStatus } from "./runStatus";

/** The stop reasons the runner can write, read from RunStop.java itself. */
const STOPS: string[] = [
  ...readFileSync(
    fileURLToPath(
      new URL(
        "../../../spectro-core/src/main/java/dev/spectroscope/core/playbook/run/RunStop.java",
        import.meta.url,
      ),
    ),
    "utf8",
  ).matchAll(/public static final String \w+ = "(\w+)";/g),
].map((m) => m[1]);

const row = (over: Partial<PlaybookRunRow>): PlaybookRunRow => ({
  run: "abcdefabcdef",
  playbook: "spectro",
  startedAt: 1,
  stopReason: null,
  result: null,
  live: false,
  graph: "s.abcdefabcdef.graph.jsonl",
  ...over,
});

describe("every stop reason the runner writes has words (card 482)", () => {
  it("reads the stop reasons from the runner, done and aborted among them", () => {
    expect(STOPS.length).toBeGreaterThanOrEqual(11);
    expect(STOPS).toContain("done");
    expect(STOPS).toContain("aborted");
  });

  it("gives each one words in both languages", () => {
    const missing = STOPS.filter((s) => {
      const words = dict[`pb.run.stop.${s}`];
      return words === undefined || words.de === "" || words.en === "";
    });
    expect(missing).toEqual([]);
  });

  it("does not word the stop reason done as if the run succeeded", () => {
    // done says an end was reached, any end; the end's own label is the result.
    expect(dict["pb.run.stop.done"].en).not.toBe("done");
    expect(dict["pb.run.stop.done"].de).not.toBe("fertig");
  });
});

describe("runStatus: the line above the run (card 482)", () => {
  it("a run that reached the end cancelled names that result and the stop reason done", () => {
    for (const lang of ["en", "de"] as const) {
      const s = runStatus(lang, row({ stopReason: "done", result: "cancelled" }));
      expect(s.stop).toBe("done");
      expect(s.result).toBe("cancelled");
      expect(s.text).toBe(
        t(lang, "pb.run.ended", { result: "cancelled", reason: t(lang, "pb.run.stop.done") }),
      );
      expect(s.text).toContain("cancelled");
      expect(s.text).not.toBe(t(lang, "pb.run.stopped", { reason: t(lang, "pb.run.stop.done") }));
    }
  });

  it("a finished run that reached the end done names the result done", () => {
    const s = runStatus("en", row({ stopReason: "done", result: "done" }));
    expect(s.stop).toBe("done");
    expect(s.result).toBe("done");
    expect(s.text).toBe(t("en", "pb.run.ended", { result: "done", reason: t("en", "pb.run.stop.done") }));
  });

  it("a run stopped before any end names the stop reason alone", () => {
    const s = runStatus("en", row({ stopReason: "aborted", result: null }));
    expect(s.stop).toBe("aborted");
    expect(s.result).toBeNull();
    expect(s.text).toBe(t("en", "pb.run.stopped", { reason: t("en", "pb.run.stop.aborted") }));
  });

  it("shows a stop reason it has no words for as it was written", () => {
    const s = runStatus("en", row({ stopReason: "from_a_newer_runner", result: null }));
    expect(s.text).toBe(t("en", "pb.run.stopped", { reason: "from_a_newer_runner" }));
  });

  it("a live run is in progress, and a run without an end record says so", () => {
    expect(runStatus("en", row({ live: true })).text).toBe(t("en", "pb.run.live"));
    expect(runStatus("en", row({ live: true })).live).toBe(true);
    const unrecorded = runStatus("en", row({}));
    expect(unrecorded.text).toBe(t("en", "pb.run.unrecorded"));
    expect(unrecorded.stop).toBeNull();
  });
});

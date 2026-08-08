import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { megabytes, opensTheSheet, readNotice, type SttStatus } from "./voiceNoticeReading";
import { VOICE_ERRORS } from "./voiceError";

describe("the first-run voice sheet reads the route, not the binaries", () => {
  const hosted: SttStatus = {
    route: "hosted",
    provider: "auto",
    speechWorks: true,
    ready: false,
    binaryHint: "brew install whisper-cpp",
    model: { present: false, expectedBytes: 1_500_000_000 },
    hosted: { keyPresent: true, keyEnv: "OPENAI_API_KEY", model: "gpt-transcribe" },
  };

  it("says speech works on the hosted route even with nothing installed", () => {
    const reading = readNotice(hosted);
    expect(reading.works).toBe(true);
    expect(reading.route).toBe("hosted");
  });

  it("never mentions the local binary while the hosted route is the one being taken", () => {
    // The whole point of the card's correction: telling a DMG user to install
    // whisper when their voice already works is the "not on this machine"
    // defect pointed the other way.
    const keys = readNotice(hosted).lines.map((l) => l.key);
    expect(keys.some((k) => k.includes("local."))).toBe(false);
    expect(readNotice(hosted).lines.every((l) => l.done)).toBe(true);
  });

  it("says plainly that audio leaves the machine, and names the model", () => {
    const leaves = readNotice(hosted).lines.find((l) => l.key.endsWith("hosted.leaves"));
    expect(leaves).toBeDefined();
    expect(leaves?.value).toBe("gpt-transcribe");
  });

  it("marks the key as the outstanding thing when hosted was chosen without one", () => {
    const reading = readNotice({
      ...hosted,
      provider: "openai",
      speechWorks: false,
      hosted: { keyPresent: false, keyEnv: "OPENAI_API_KEY", model: "gpt-transcribe" },
    });
    expect(reading.works).toBe(false);
    expect(reading.chosen).toBe(true);
    const key = reading.lines.find((l) => l.key.endsWith("hosted.keyMissing"));
    expect(key?.done).toBe(false);
    expect(key?.value).toBe("OPENAI_API_KEY");
  });
});

describe("the local route names what is missing, and what it would cost", () => {
  const local: SttStatus = {
    route: "local",
    provider: "local",
    speechWorks: false,
    ready: false,
    binaryHint: "brew install whisper-cpp",
    model: { present: false, expectedBytes: 1_500_000_000 },
    hosted: { keyPresent: false, keyEnv: "OPENAI_API_KEY", model: "gpt-transcribe" },
  };

  it("carries the install line the server computed, never one of its own", () => {
    const line = readNotice(local).lines.find((l) => l.key.endsWith("local.binaryMissing"));
    expect(line?.value).toBe("brew install whisper-cpp");
    expect(line?.done).toBe(false);
  });

  it("says the download size before it is started, not after", () => {
    const line = readNotice(local).lines.find((l) => l.key.endsWith("local.modelMissing"));
    expect(line?.value).toBe("1500 MB");
    expect(line?.done).toBe(false);
  });

  it("promises that nothing leaves the machine on this route", () => {
    expect(readNotice(local).lines.some((l) => l.key.endsWith("local.staysHere"))).toBe(true);
  });

  it("reports every line settled once the binary and the model are both there", () => {
    const ready = readNotice({
      ...local,
      speechWorks: true,
      ready: true,
      binaryHint: null,
      model: { present: true, expectedBytes: 1_500_000_000 },
    });
    expect(ready.works).toBe(true);
    expect(ready.lines.every((l) => l.done)).toBe(true);
  });

  it("treats a missing route as local rather than guessing hosted", () => {
    // An older server answers without the field. Assuming hosted there would
    // promise a reader that audio stays put when it may not.
    expect(readNotice({}).route).toBe("local");
    expect(readNotice({}).works).toBe(false);
  });
});

describe("the configured provider is spelled the way the server stores it", () => {
  it('reads a deliberate hosted choice from "openai", which is the stored value', () => {
    // SttRoute.of matches "openai"; nothing in the system ever stores "hosted".
    // Reading the wrong spelling would report an auto-derived route as chosen.
    expect(readNotice({ route: "hosted", provider: "openai" }).chosen).toBe(true);
    expect(readNotice({ route: "hosted", provider: "hosted" }).chosen).toBe(false);
    expect(readNotice({ route: "local", provider: "local" }).chosen).toBe(true);
    expect(readNotice({ route: "hosted", provider: "auto" }).chosen).toBe(false);
  });
});

describe("which reasons earn the sheet", () => {
  it("opens for the setup case, and only that one", () => {
    expect(opensTheSheet("sttMissing")).toBe(true);
    for (const reason of VOICE_ERRORS.filter((r) => r !== "sttMissing")) {
      expect(opensTheSheet(reason), reason).toBe(false);
    }
  });
});

describe("the sentences exist in both languages", () => {
  it("has every key the reading can produce, in de and en", () => {
    const produced = new Set<string>();
    const shapes: SttStatus[] = [
      { route: "hosted", hosted: { keyPresent: true } },
      { route: "hosted", hosted: { keyPresent: false } },
      { route: "local", binaryHint: "x", model: { present: false, expectedBytes: 1 } },
      { route: "local", binaryHint: null, model: { present: true } },
    ];
    for (const s of shapes) for (const line of readNotice(s).lines) produced.add(line.key);
    expect(produced.size).toBeGreaterThan(0);
    for (const key of produced) {
      expect(dict[key], `${key} is missing from the dictionary`).toBeDefined();
      expect(dict[key].de.length, `${key} has no German`).toBeGreaterThan(0);
      expect(dict[key].en.length, `${key} has no English`).toBeGreaterThan(0);
    }
  });
});

describe("megabytes", () => {
  it("rounds to whole megabytes, which is the grain a reader can act on", () => {
    expect(megabytes(1_500_000_000)).toBe("1500 MB");
    expect(megabytes(0)).toBe("0 MB");
  });
});

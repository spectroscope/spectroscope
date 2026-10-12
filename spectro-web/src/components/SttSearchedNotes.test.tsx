// Card 449: when whisper-cli is still missing, the speech-to-text pane says
// which folders the server looked in. The owner installed it with brew on a
// host where the app was started from the Dock, and the pane only said "not
// found"; the folder it went into was never searched.
//
// No DOM in this suite, so the note is rendered to static markup, and the
// pane, which fetches before it renders anything, is held by its source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SttLocalLiveNote, SttRunnerNote, SttSearchedNotes, type SttBinaryState } from "./SttSearchedNotes";
import { dict } from "../i18n/i18n";

const SEARCHED = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const missing: SttBinaryState = { found: false, path: null, searched: SEARCHED };

describe("SttSearchedNotes", () => {
  it("names every folder searched for a missing binary, in search order", () => {
    const html = renderToStaticMarkup(<SttSearchedNotes binaries={{ "whisper-cli": missing }} lang="en" />);

    expect(html).toContain("Looked for whisper-cli in:");
    expect(html).toContain(SEARCHED.join(", "));
  });

  it("says it in German too", () => {
    const html = renderToStaticMarkup(<SttSearchedNotes binaries={{ "whisper-cli": missing }} lang="de" />);

    expect(html).toContain("whisper-cli gesucht in:");
    expect(html).toContain(SEARCHED.join(", "));
  });

  it("says nothing about a binary that was found", () => {
    const found: SttBinaryState = {
      found: true,
      path: "/opt/homebrew/bin/whisper-cli",
      searched: SEARCHED,
    };
    const html = renderToStaticMarkup(<SttSearchedNotes binaries={{ "whisper-cli": found }} lang="en" />);

    expect(html).toBe("");
  });

  it("says nothing when an older server sends no folder list", () => {
    const html = renderToStaticMarkup(
      <SttSearchedNotes binaries={{ "whisper-cli": { found: false, path: null } }} lang="en" />,
    );

    expect(html).toBe("");
  });

  it("is rendered by the speech-to-text pane from the status's binaries", () => {
    const pane = readFileSync(fileURLToPath(new URL("./SttSettings.tsx", import.meta.url)), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "");

    expect(pane).toContain("<SttSearchedNotes binaries={status.binaries} lang={lang} />");
  });

  it("has the sentence in both languages, with the binary's name in it", () => {
    expect(dict["set.sttSearched"]?.en).toContain("{name}");
    expect(dict["set.sttSearched"]?.de).toContain("{name}");
  });
});

describe("SttLocalLiveNote (card 527)", () => {
  const available = { available: true, chunkMs: 2000, windowMs: 30000 };

  it("names the chunk step and says local live is on", () => {
    const html = renderToStaticMarkup(<SttLocalLiveNote localLive={available} wanted={true} lang="en" />);

    expect(html).toContain(
      "Live text on this machine is on: whisper runs every 2 s over what you have said so far.",
    );
  });

  it("names the chunk step and says local live is off", () => {
    const html = renderToStaticMarkup(<SttLocalLiveNote localLive={available} wanted={false} lang="en" />);

    expect(html).toContain("Live text on this machine is off.");
    expect(html).toContain("every 2 s");
  });

  it("says it in German too", () => {
    const html = renderToStaticMarkup(<SttLocalLiveNote localLive={available} wanted={true} lang="de" />);

    expect(html).toContain(
      "Live-Text auf diesem Rechner ist an: whisper läuft alle 2 s über das bisher Gesagte.",
    );
  });

  it("says nothing when the local route cannot stream or the server is older", () => {
    expect(
      renderToStaticMarkup(
        <SttLocalLiveNote localLive={{ ...available, available: false }} wanted={true} lang="en" />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<SttLocalLiveNote localLive={undefined} wanted={true} lang="en" />)).toBe("");
  });

  it("is drawn by the speech pane", () => {
    const pane = readFileSync(fileURLToPath(new URL("./SttSettings.tsx", import.meta.url)), "utf8");
    expect(pane).toContain("<SttLocalLiveNote");
  });

  it("carries both languages for every new sentence", () => {
    for (const key of [
      "set.sttLocalLive.on",
      "set.sttLocalLive.off",
      "mic.finishing",
      "voice.live.localRoute",
    ]) {
      expect(dict[key]?.en, key).toBeTruthy();
      expect(dict[key]?.de, key).toBeTruthy();
    }
  });
});

describe("SttRunnerNote (card 528)", () => {
  it("names the port of a resident whisper-server that is up", () => {
    const runner = { configured: "auto", running: "server", port: 51234, up: true, fallback: false };
    const html = renderToStaticMarkup(<SttRunnerNote runner={runner} lang="en" />);

    expect(html).toContain("whisper-server runs on 127.0.0.1:51234 with the speech model loaded.");
  });

  it("says the next press starts a whisper-server that is down", () => {
    const runner = { configured: "server", running: "server", port: null, up: false, fallback: false };
    const html = renderToStaticMarkup(<SttRunnerNote runner={runner} lang="de" />);

    expect(html).toContain(
      "whisper-server läuft gerade nicht. Der nächste Klick auf das Mikrofon startet ihn und lädt das Modell.",
    );
  });

  it("says whisper-cli loads the model on every press", () => {
    const runner = { configured: "cli", running: "cli", port: null, up: false, fallback: false };
    const html = renderToStaticMarkup(<SttRunnerNote runner={runner} lang="en" />);

    expect(html).toContain("whisper-cli runs once per chunk and loads the speech model each time.");
  });

  it("says why whisper-cli runs when whisper-server is missing", () => {
    const runner = { configured: "server", running: "cli", port: null, up: false, fallback: true };
    const html = renderToStaticMarkup(<SttRunnerNote runner={runner} lang="en" />);

    expect(html).toContain("whisper-server is not installed, so whisper-cli runs.");
  });

  it("says nothing against an older server without a runner", () => {
    expect(renderToStaticMarkup(<SttRunnerNote runner={undefined} lang="en" />)).toBe("");
  });

  it("carries every new sentence in both languages", () => {
    for (const key of [
      "set.sttRunner",
      "set.sttRunner.auto",
      "set.sttRunner.cli",
      "set.sttRunner.server",
      "set.sttRunnerState.up",
      "set.sttRunnerState.down",
      "set.sttRunnerState.cli",
      "set.sttRunnerState.fallback",
    ]) {
      const entry = (dict as Record<string, { de: string; en: string }>)[key];
      expect(entry, key).toBeDefined();
      expect(entry.de.length > 0 && entry.en.length > 0, key).toBe(true);
      const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
      expect(dashes.test(entry.de + entry.en), `${key} has a dash`).toBe(false);
    }
  });
});

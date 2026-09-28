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

import { SttSearchedNotes, type SttBinaryState } from "./SttSearchedNotes";
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

// Card 449: where the server looked for a speech-to-text binary it did not find.
//
// The owner installed whisper-cli with brew on a host where the app was started
// from the Dock, and this pane said "not found". The server searched launchd's
// four folders and not the Homebrew prefix. It now searches the tool shell's
// PATH and sends the folder list with every binary; this note shows that list
// for each binary that is still missing, so the reader can see whether the
// folder it was installed into is one of them.

import { t, type Lang } from "../i18n/i18n";

/** One binary as `/api/stt/status` reports it. */
export interface SttBinaryState {
  found: boolean;
  path: string | null;
  /** The folders searched, in order. Absent from servers older than card 449. */
  searched?: string[];
}

/**
 * One note per missing binary that came with a folder list.
 *
 * @param binaries the status's `binaries` map
 * @param lang the interface language
 * @returns the notes, or null when every binary was found or no list came
 */
export function SttSearchedNotes({
  binaries,
  lang,
}: {
  binaries: Record<string, SttBinaryState>;
  lang: Lang;
}) {
  const missing = Object.entries(binaries).filter(([, bin]) => !bin.found && (bin.searched?.length ?? 0) > 0);
  if (missing.length === 0) return null;
  return (
    <>
      {missing.map(([name, bin]) => (
        <p key={name} className="settings-note">
          {t(lang, "set.sttSearched", { name })}{" "}
          <code className="mono">{(bin.searched ?? []).join(", ")}</code>
        </p>
      ))}
    </>
  );
}

/** Card 528: what runs whisper for live text on the local route. */
export interface SttRunnerState {
  /** The `sttRunner` setting: auto, cli or server. */
  configured?: string | null;
  /** What a recording runs now: server or cli. */
  running?: string | null;
  /** The resident whisper-server's loopback port while it runs, else null. */
  port?: number | null;
  /** Whether the resident whisper-server is up with the model loaded. */
  up?: boolean | null;
  /** True when the setting asks for the server and whisper-server is missing. */
  fallback?: boolean | null;
}

/** The part of `/api/stt/status` about live text on the local route (card 527). */
export interface SttLocalLive {
  available?: boolean | null;
  chunkMs?: number | null;
  windowMs?: number | null;
  /** Card 528: the runner, its port and whether the server is up. */
  runner?: SttRunnerState | null;
}

/**
 * Card 528: which program runs whisper for live text, and whether the resident
 * whisper-server is up. Silent against an older server that does not say.
 *
 * @param runner the status's `localLive.runner`
 * @param lang the interface language
 * @returns the note, or null
 */
export function SttRunnerNote({ runner, lang }: { runner: SttRunnerState | null | undefined; lang: Lang }) {
  if (runner === null || runner === undefined || typeof runner.running !== "string") return null;
  let line: string;
  if (runner.running === "server") {
    line =
      runner.up === true && typeof runner.port === "number"
        ? t(lang, "set.sttRunnerState.up", { port: String(runner.port) })
        : t(lang, "set.sttRunnerState.down");
  } else {
    line = t(lang, runner.fallback === true ? "set.sttRunnerState.fallback" : "set.sttRunnerState.cli");
  }
  return <p className="settings-note">{line}</p>;
}

/**
 * Card 527: whether the local route writes along live, and how often a whisper
 * run covers what was said so far. Silent when the local route cannot stream,
 * and against an older server that does not report it.
 *
 * @param localLive the status's `localLive`
 * @param wanted whether live text is switched on in this browser
 * @param lang the interface language
 * @returns the note, or null
 */
export function SttLocalLiveNote({
  localLive,
  wanted,
  lang,
}: {
  localLive: SttLocalLive | null | undefined;
  wanted: boolean;
  lang: Lang;
}) {
  if (localLive?.available !== true || typeof localLive.chunkMs !== "number") return null;
  const seconds = String(localLive.chunkMs / 1000);
  return (
    <p className="settings-note">
      {t(lang, wanted ? "set.sttLocalLive.on" : "set.sttLocalLive.off", {
        s: lang === "de" ? seconds.replace(".", ",") : seconds,
      })}
    </p>
  );
}

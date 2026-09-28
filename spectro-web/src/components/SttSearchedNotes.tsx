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

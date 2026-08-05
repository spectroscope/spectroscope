// Three buttons that show a session's own files.
//
// ONE component, mounted twice — beside the chat's export row and beside the
// trace's Langfuse link, which is where the owner asked for them ("gerne beim
// chat oder beim trace oder (wie der langfuse button)"). Two mounts rather than
// two copies: the pair drifted apart in this codebase before, and a folder
// button that exists on one tab and not the other is the kind of small
// inconsistency nobody reports and everybody notices.
//
// A button appears only for a folder the server just stat'd. A scratchpad comes
// and goes with a temp sweep, so the answer is fetched per session rather than
// remembered, and a button that opens nothing is never drawn.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  folderLabelKey,
  loadSessionFolders,
  openSessionFolder,
  shownFolders,
  type OpenResult,
  type SessionFolder,
} from "../import/sessionFolders";

export function SessionFolderButtons(props: { storePath: string | null; className?: string }) {
  const lang = useLang();
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setFailed(null);
    if (props.storePath === null) {
      setFolders([]);
      return;
    }
    let alive = true;
    void loadSessionFolders(props.storePath).then((found) => {
      if (alive) setFolders(found);
    });
    return () => {
      // A reader who switches session while this is in flight must not get the
      // previous session's folders painted over the new one.
      alive = false;
    };
  }, [props.storePath]);

  const shown = shownFolders(folders);
  if (props.storePath === null || shown.length === 0) return null;

  const press = (kind: string): void => {
    setFailed(null);
    void openSessionFolder(props.storePath as string, kind).then((r: OpenResult) => {
      // Only the failures are worth a word. A Finder window that opened is its
      // own confirmation, and a toast for it would be noise on every press.
      if (r !== "opened") setFailed(kind);
    });
  };

  return (
    <span className={props.className ?? "folder-buttons"}>
      {shown.map((f) => (
        <button
          key={f.kind}
          type="button"
          className="trace-lens mono"
          // The absolute path, so a reader can see WHERE a press goes before
          // making it — and can copy it out of the tooltip for a terminal.
          title={f.path}
          onClick={() => press(f.kind)}
        >
          {t(lang, folderLabelKey(f.kind) as string)}
        </button>
      ))}
      {failed !== null && (
        <span className="trace-lens mono" title={t(lang, "folder.failedTitle")}>
          {t(lang, "folder.failed")}
        </span>
      )}
    </span>
  );
}

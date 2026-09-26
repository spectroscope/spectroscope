// Card 445: renaming in place. The row's title becomes a small field holding
// the title the row showed, all of it selected. Enter or leaving the field
// saves, Escape cancels. What is sent is renameRequest's call: nothing when the
// field still holds the text it opened with, "" when it was emptied (the row
// falls back to the suggestion or the first prompt).

import { useEffect, useRef } from "react";
import { t, type Lang } from "../i18n/i18n";
import { TITLE_MAX_CHARS } from "../state/sessionMeta";
import { renameIntent } from "./rowMenuItems";

export function SessionRenameField(props: {
  lang: Lang;
  /** What the row showed when the field opened. */
  initial: string;
  /** Called once: the typed text on save, null on cancel, and whether a key
   *  closed the field (Enter, Escape) or focus left it. */
  onDone: (typed: string | null, by: "key" | "blur") => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter saves and then the field unmounts, which blurs it: without this the
  // same rename would be sent twice.
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (typed: string | null, by: "key" | "blur"): void => {
    if (done.current) return;
    done.current = true;
    props.onDone(typed, by);
  };

  return (
    <input
      className="session-rename"
      ref={ref}
      type="text"
      defaultValue={props.initial}
      maxLength={TITLE_MAX_CHARS}
      aria-label={t(props.lang, "sess.rename.label")}
      onKeyDown={(e) => {
        // Enter that confirms an input method's composition is not a save.
        if (e.nativeEvent.isComposing) return;
        const intent = renameIntent(e.key);
        if (intent === null) return;
        e.preventDefault();
        finish(intent === "save" ? e.currentTarget.value : null, "key");
      }}
      onBlur={(e) => finish(e.currentTarget.value, "blur")}
    />
  );
}

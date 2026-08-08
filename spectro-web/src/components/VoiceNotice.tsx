// Card 187 step 7: the first-run sheet for voice.
//
// Shown once per home when somebody first reaches for the microphone, and again
// whenever the SETUP is what is wrong — because that case takes the microphone
// button away and its tooltip with it.
//
// The sentences and the branching live in voiceNoticeReading.ts so they are testable
// without a DOM; this file is the markup, on the pattern LocalModelNotice and
// LevelingIntro already use.
import { useEffect } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { readNotice, type SttStatus } from "./voiceNoticeReading";

export function VoiceNotice(props: {
  /** What `/api/stt/status` answered, or null while it has not answered yet. */
  status: SttStatus | null;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const lang = useLang();
  const { onDismiss } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // No status yet is not "broken" — it is "not answered". Saying either of the
  // two headlines here would be a guess, so the sheet waits rather than lies.
  if (props.status === null) return null;
  const reading = readNotice(props.status);

  const say = (key: string, value?: string): string => {
    const s = t(lang, key);
    return value === undefined ? s : s.replace("{v}", value);
  };

  return (
    <div className="km-backdrop" onClick={props.onDismiss} role="presentation">
      <div
        className="km-panel ob-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "voice.notice.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="km-head">
          <span className="km-title">{t(lang, "voice.notice.title")}</span>
          <button
            type="button"
            className="km-close"
            onClick={props.onDismiss}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>

        <p className="ob-intro">{t(lang, reading.works ? "voice.notice.works" : "voice.notice.blocked")}</p>

        <ul className="ob-opts">
          {reading.lines.map((line) => (
            <li className="ob-opt" key={line.key}>
              <div className="ob-opt-head">
                {/* The badge is the state, not a decoration: a reader scanning
                    the column should be able to tell settled from outstanding
                    without reading a sentence. */}
                <span className="ob-opt-badge mono">{line.done ? "✓" : "·"}</span>
                <span className="ob-opt-title">{say(line.key, line.value)}</span>
              </div>
            </li>
          ))}
        </ul>

        {/* ob-foot and soft-primary, which is what the two sheets beside this
            one use. km-foot/btn exist in no stylesheet — checked, after writing
            them from memory and getting all three names wrong. */}
        <div className="ob-foot">
          <span className="ob-foot-note">{t(lang, "voice.notice.switchHint")}</span>
          <button type="button" className="ghost" onClick={props.onOpenSettings}>
            {t(lang, "voice.notice.settings")}
          </button>
          <button type="button" className="soft-primary" onClick={props.onDismiss}>
            {t(lang, "voice.notice.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}

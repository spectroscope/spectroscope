// The working folder row: where the agent works this session. It sits in the
// live composer column, directly above the input box (card 389), and Chat
// mounts it only until the chat's first prompt starts a run (card 428). It
// draws three options:
//
//   - no folder: nothing chosen, a run gets a temporary folder of its own
//     (the "random" mode on the wire);
//   - default: the default working folder from the settings, or a fallback
//     folder when none is set;
//   - choose folder: the native folder picker.
//
// The server resolves the actual path per mode (SessionConnection.onSetWorkspace).
// The marked option follows the server's announcement until a click, and a
// click still applies, so a configured default is never overridden silently.
// While canPick is false the row draws its options disabled, with the reason
// the server gives for refusing a change as the tooltip.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { ClientMessage } from "../events";
import type { WorkspaceInfo } from "../state/reducer";
import {
  CHOOSER_OPTIONS,
  chooserFolder,
  chooserTitle,
  clipName,
  folderName,
  preselectedOption,
  type ChooserOption,
} from "../workspace/chooserMode";

/** The longest folder name the "is no longer there" sentence carries. */
const GONE_NAME_MAX = 24;

/** The text a template puts before and after its `{name}`. */
function wordsAround(template: string): [string, string] {
  const at = template.indexOf("{name}");
  return at < 0 ? [template, ""] : [template.slice(0, at), template.slice(at + "{name}".length)];
}

export function WorkspaceChooser(props: {
  sendClient: (m: ClientMessage) => boolean;
  onPickFolder: () => void;
  /** The workspace announcement: prospective before a run, resolved after. */
  workspace: WorkspaceInfo | null;
  /** False while a run streams; the server refuses a change once its agent exists. */
  canPick: boolean;
}) {
  const lang = useLang();
  const [picked, setPicked] = useState<ChooserOption | null>(null);
  // The row stays mounted across "New chat" from a chat that had no prompt
  // yet, and New chat resets the announcement to null. A click belongs to
  // the chat it was made in, so the drop to null
  // forgets it (state adjusted during render, the React idiom for this).
  const [announced, setAnnounced] = useState(props.workspace !== null);
  if (announced !== (props.workspace !== null)) {
    setAnnounced(props.workspace !== null);
    if (props.workspace === null) setPicked(null);
  }
  // A click wins; until then the announcement speaks.
  const chosen: ChooserOption | null = picked ?? preselectedOption(props.workspace);
  const title = chooserTitle(props.workspace);
  const folder = chooserFolder(props.workspace);
  // A folder named under the no-folder entry is the temporary one a run got.
  const temporary = folder !== null && chosen === "random";
  const unavailable = props.workspace?.unavailable ?? null;
  const gone = unavailable === null ? null : clipName(folderName(unavailable) ?? unavailable, GONE_NAME_MAX);
  // The name and the words around it are separate spans, so a narrow row can
  // shorten the name and never the words that say it is gone.
  const goneWords = wordsAround(t(lang, "workspace.unavailable"));
  const locked = !props.canPick;
  const fixed = t(lang, "workspace.fixed");

  const pick = (option: ChooserOption): void => {
    if (locked) return;
    setPicked(option);
    if (option === "set") props.onPickFolder();
    else props.sendClient({ type: "set_workspace", mode: option });
  };

  return (
    <div className="ws-chooser" title={locked ? fixed : undefined}>
      <div className="ws-chooser-line">
        <span className="ws-chooser-label mono">{t(lang, "workspace.label")}</span>
        <div className="ws-chooser-opts" role="radiogroup" aria-label={t(lang, "workspace.label")}>
          {CHOOSER_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              data-option={option}
              aria-checked={chosen === option}
              className={`ws-chooser-opt${chosen === option ? " ws-chooser-opt--on" : ""}`}
              title={locked ? fixed : t(lang, `workspace.hint.${option}`)}
              disabled={locked}
              onClick={() => pick(option)}
            >
              {t(lang, `workspace.opt.${option}`)}
            </button>
          ))}
        </div>
        {/* Drawn with nothing in it too: a narrow row keeps this line. */}
        <span className="ws-chooser-where">
          {folder !== null && (
            <span className="ws-chooser-folder mono" title={title ?? undefined}>
              {folder}
              {temporary && <span className="ws-chooser-new"> · {t(lang, "workspace.temporary")}</span>}
              {props.workspace?.exists === false && (
                <span className="ws-chooser-new"> · {t(lang, "workspace.willCreate")}</span>
              )}
            </span>
          )}
          {gone !== null && unavailable !== null && (
            <span className="ws-chooser-gone mono" title={unavailable}>
              {goneWords[0] !== "" && <span className="ws-chooser-gone-words">{goneWords[0]}</span>}
              <span className="ws-chooser-gone-name">{gone}</span>
              {goneWords[1] !== "" && <span className="ws-chooser-gone-words">{goneWords[1]}</span>}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

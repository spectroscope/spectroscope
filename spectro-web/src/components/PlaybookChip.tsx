// Card 554, criteria 4 and 8e: the playbook of this session, in the header
// beside the folder chip, in developer mode only (AppHeader decides).
//
// The dropdown lists the registered playbook folders. It shows the session's
// pick; with no pick it shows the playbook pinned for the workspace as a
// suggestion that is not stored (owner answer 5): the pick is stored when the
// owner picks here, with /playbook use, or by starting a run. A picked folder
// that no longer holds a playbook stays shown and says "not found"; the server
// refuses a start with it.
//
// Integrator decision b: "No playbook" is an option of its own. Choosing it
// stores the explicit none for the session; the pinned playbook is then no
// longer suggested, and /run-with-playbook is refused.
//
// The play button writes "/run-with-playbook " into the composer of the
// session in view and starts nothing (criterion 4): the owner types the prompt
// and sends it, and the start sheet confirms it.
//
// It is no icon button of the header's table (appHeaderIcons.test.tsx).
// Styles: styles/header.css.

import { useEffect } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { prefillComposer } from "../state/composerPrefill";
import { refreshFolders, usePlaybookFolders } from "../state/playbooks";
import type { PlaybookPick } from "../state/playbookChat";
import { folderName } from "../state/playbookCommands";

/** What the play button writes into the composer. */
export const RUN_WITH_PLAYBOOK_DRAFT = "/run-with-playbook ";

/** The option value of "No playbook"; no folder path looks like it. */
export const NO_PLAYBOOK_OPTION = "__none__";

/**
 * @param props.folders the registered playbook folders
 * @param props.pinned  the folder pinned for the workspace, or null
 * @param props.pick    the session's pick from playbook_info, or null before the first frame
 * @param props.onPick  sends the owner's pick (set_playbook), null for "No playbook"; never called for the suggestion
 * @param props.onPlay  writes the command into the composer
 */
export function PlaybookChipView(props: {
  folders: readonly string[];
  pinned: string | null;
  pick: PlaybookPick | null;
  onPick: (dir: string | null) => void;
  onPlay: () => void;
}) {
  const lang = useLang();
  const picked = props.pick?.dir ?? null;
  const off = picked === null && props.pick?.none === true;
  const shown = picked ?? (off ? null : props.pinned);
  const gone = picked !== null && props.pick?.found === false;
  const state = off
    ? "off"
    : gone
      ? "gone"
      : picked !== null
        ? "picked"
        : shown !== null
          ? "suggested"
          : "none";
  const options =
    shown !== null && !props.folders.includes(shown) ? [...props.folders, shown] : [...props.folders];
  const label = (dir: string): string =>
    dir === picked && props.pick?.name != null ? props.pick.name : folderName(dir);
  const canPlay = shown !== null && !gone;

  return (
    <div className="pb-chip" data-state={state}>
      <select
        className="pb-chip-select"
        aria-label={t(lang, "pbchip.label")}
        title={
          gone
            ? t(lang, "pbchip.notFoundTitle")
            : state === "suggested"
              ? t(lang, "pbchip.suggestedTitle")
              : (shown ?? t(lang, "pbchip.label"))
        }
        value={off ? NO_PLAYBOOK_OPTION : (shown ?? "")}
        onChange={(e) => {
          const value = e.target.value;
          if (value === NO_PLAYBOOK_OPTION) props.onPick(null);
          else if (value !== "") props.onPick(value);
        }}
      >
        {shown === null && !off && (
          <option value="" disabled>
            {t(lang, "pbchip.choose")}
          </option>
        )}
        {options.map((dir) => (
          <option key={dir} value={dir}>
            {label(dir)}
          </option>
        ))}
        <option value={NO_PLAYBOOK_OPTION}>{t(lang, "pbchip.noPlaybook")}</option>
      </select>
      {state === "suggested" && <span className="pb-chip-note">{t(lang, "pbchip.suggested")}</span>}
      {gone && (
        <span className="pb-chip-note pb-chip-note--gone" role="status">
          {t(lang, "pbchip.notFound")}
        </span>
      )}
      <button
        type="button"
        className="pb-chip-play"
        aria-label={t(lang, "pbchip.play")}
        title={
          canPlay ? t(lang, "pbchip.play") : t(lang, gone ? "pbchip.notFoundTitle" : "pbchip.playNeedsPick")
        }
        disabled={!canPlay}
        onClick={props.onPlay}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M5 3.5v9l7.5-4.5z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

/**
 * The chip with the registered folders and the workspace's pin read from the
 * playbook store; the play button writes into the composer through
 * state/composerPrefill.ts.
 *
 * @param props.workspace the session's workspace path, for its pin; null reads no pin
 * @param props.pick      the session's pick (UiState.playbook)
 * @param props.onPick    sends set_playbook for the owner's pick, null for "No playbook"
 * @param props.onShowComposer brings the composer on screen after the play button wrote into it
 */
export function PlaybookChip(props: {
  workspace: string | null;
  pick: PlaybookPick | null;
  onPick: (dir: string | null) => void;
  onShowComposer?: () => void;
}) {
  const { folders, active } = usePlaybookFolders();
  const { workspace } = props;
  // Fix round 3: the folders are listed with or without a workspace; only the
  // suggestion (the pin) needs one.
  useEffect(() => {
    refreshFolders(workspace).catch(() => {});
  }, [workspace]);
  return (
    <PlaybookChipView
      folders={folders}
      pinned={workspace === null ? null : active}
      pick={props.pick}
      onPick={props.onPick}
      onPlay={() => {
        prefillComposer(RUN_WITH_PLAYBOOK_DRAFT);
        props.onShowComposer?.();
      }}
    />
  );
}

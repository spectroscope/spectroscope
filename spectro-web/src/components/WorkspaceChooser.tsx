// The new-chat workspace chooser: where the agent works this session. Three
// modes: random (a throwaway per-session temp folder), default (your configured
// workspace, or ~/spectroscope-workspace when none is set), and set (pick a
// folder). The backend resolves the actual path per mode
// (SessionConnection.onSetWorkspace); "set" reuses the native folder picker.
//
// The selection follows the server's announcement rather than a constant. It
// used to open on "random" while buildAgentOnce resolves `pinned != null ?
// pinned : config.workspace()`, so with a configured workspace the empty chat
// showed one answer and the first run used another. Clicking still applies, so
// a configured default is never overridden silently; what changed is that the
// unclicked state now reports the truth instead of a guess.

import { useState } from "react";
import { useLang } from "../state/lang";
import type { ClientMessage } from "../events";
import type { WorkspaceInfo } from "../state/reducer";
import { chooserFolder, preselectedMode } from "../workspace/chooserMode";

type Mode = "random" | "default" | "set";

export function WorkspaceChooser(props: {
  sendClient: (m: ClientMessage) => boolean;
  onPickFolder: () => void;
  /** The prospective workspace announcement, what a run started now would use. */
  workspace: WorkspaceInfo | null;
}) {
  const de = useLang() === "de";
  const [picked, setPicked] = useState<Mode | null>(null);
  // A click wins; until then the announcement speaks.
  const chosen: Mode | null = picked ?? preselectedMode(props.workspace);
  // The folder, named. The announcement has carried it all along and this
  // screen printed only the word "default" — the one place that exists to say
  // where the agent will work said everything but the folder.
  const folder = picked === null || picked === chosen ? chooserFolder(props.workspace) : null;

  const pick = (mode: Mode): void => {
    setPicked(mode);
    if (mode === "set") props.onPickFolder();
    else props.sendClient({ type: "set_workspace", mode });
  };

  const opts: { key: Mode; label: string; hint: string }[] = [
    {
      key: "random",
      label: de ? "zufall" : "random",
      hint: de ? "frischer temp-ordner pro chat" : "a fresh temp folder per chat",
    },
    {
      key: "default",
      label: de ? "standard" : "default",
      hint: de
        ? "dein default-workspace (oder ~/spectroscope-workspace)"
        : "your default workspace (or ~/spectroscope-workspace)",
    },
    {
      key: "set",
      label: de ? "ordner wählen…" : "set folder…",
      hint: de ? "einen bestimmten ordner picken" : "pick a specific folder",
    },
  ];

  return (
    <div className="ws-chooser">
      <span className="ws-chooser-label mono">{de ? "arbeitsordner" : "workspace"}</span>
      <div className="ws-chooser-opts" role="radiogroup" aria-label={de ? "arbeitsordner" : "workspace"}>
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={chosen === o.key}
            className={`ws-chooser-opt${chosen === o.key ? " ws-chooser-opt--on" : ""}`}
            title={o.hint}
            onClick={() => pick(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {folder !== null && (
        <span className="ws-chooser-folder mono" title={props.workspace?.path ?? undefined}>
          {folder}
          {props.workspace?.exists === false && (
            <span className="ws-chooser-new"> · {de ? "wird angelegt" : "will be created"}</span>
          )}
        </span>
      )}
    </div>
  );
}

// The new-chat workspace chooser: where the agent works this session. Three
// modes — random (a throwaway per-session temp folder, the pre-selected default),
// default (your configured workspace, or ~/spectroscope-workspace when none is
// set), and set (pick a folder). The backend resolves the actual path per mode
// (SessionConnection.onSetWorkspace); "set" reuses the native folder picker.
// It only applies on click, so a configured default is never overridden silently.

import { useState } from "react";
import { useLang } from "../state/lang";
import type { ClientMessage } from "../events";

type Mode = "random" | "default" | "set";

export function WorkspaceChooser(props: {
  sendClient: (m: ClientMessage) => boolean;
  onPickFolder: () => void;
}) {
  const de = useLang() === "de";
  const [chosen, setChosen] = useState<Mode>("random");

  const pick = (mode: Mode): void => {
    setChosen(mode);
    if (mode === "set") props.onPickFolder();
    else props.sendClient({ type: "set_workspace", mode });
  };

  const opts: { key: Mode; label: string; hint: string }[] = [
    {
      key: "random",
      label: de ? "wegwerf" : "random",
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
    </div>
  );
}

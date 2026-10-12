// Card 219, first cut — the terminal as a panel of its own.
//
// Before this card the terminal lived INSIDE the Files tab (card 93), so
// glancing at the roster unmounted WorkspaceTab and took the PTY with it: a
// running shell died because a neighbour was looked at. As a dock panel it
// lives exactly as long as its panel is open — closing the panel is the
// deliberate way to end the shell, folding it (display:none) keeps it alive.
//
// The honesty rules move here with the terminal, unchanged in substance:
// a shell belongs to a session (ShellCwd refuses a request without one), and
// a build without the PTY helper says so before a press instead of printing
// "connection refused" after one.
//
// Card 520: the panel reads the dock's workspace, so a stored session woken by
// a click opens its shell in the recorded folder. A woken session whose folder
// is gone keeps the panel shut: the server would create the folder for a
// shell (ShellCwd.ensure), and nobody chose that.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { TerminalPane } from "../workspace/TerminalPane";
import type { WorkspaceInfo } from "../state/reducer";
import { recordedFolderGone } from "../workspace/paneState";

/** What /api/config says about shells in this process. */
type ShellState = "ready" | "off" | "unavailable";

export function TerminalPanel({ workspace }: { workspace: WorkspaceInfo | null }): React.JSX.Element {
  const lang = useLang();
  const [shell, setShell] = useState<ShellState | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { shell?: string } | null) => {
        if (!alive || c == null) return;
        // An older server says nothing here; treat silence as "ready" so this
        // panel keeps behaving exactly as the Files tab's toggle did.
        setShell(c.shell === "off" || c.shell === "unavailable" ? c.shell : "ready");
      })
      .catch(() => setShell("ready"));
    return () => {
      alive = false;
    };
  }, []);

  if (workspace !== null && recordedFolderGone(workspace)) {
    return (
      <div className="ctx-empty ws-pending">
        <p>{t(lang, "dock.termGone")}</p>
        <p className="ws-pending-path mono" title={workspace.unavailable}>
          {workspace.unavailable}
        </p>
      </div>
    );
  }
  const sessionId = workspace?.sessionId;
  if (sessionId === undefined) {
    // No session yet — there is no folder to open a shell in, and offering a
    // button that can only fail is the dishonesty the Files pane exists to
    // avoid. Same rule, new home.
    return <p className="ctx-empty">{t(lang, "dock.termNoSession")}</p>;
  }
  if (shell === null) return <p className="ctx-empty">{t(lang, "dock.termChecking")}</p>;
  if (shell !== "ready") {
    return <p className="ctx-empty">{t(lang, shell === "off" ? "dock.termOff" : "dock.termAbsent")}</p>;
  }
  return (
    <div className="dock-term">
      <TerminalPane sessionId={sessionId} />
    </div>
  );
}

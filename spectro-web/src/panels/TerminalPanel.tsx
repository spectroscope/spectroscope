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

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { TerminalPane } from "../workspace/TerminalPane";

/** What /api/config says about shells in this process. */
type ShellState = "ready" | "off" | "unavailable";

export function TerminalPanel({ sessionId }: { sessionId?: string }): React.JSX.Element {
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

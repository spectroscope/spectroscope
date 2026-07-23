// The fleet's own home, shown on the chat tab when a fleet is entered — instead
// of the (stale, session-scoped) chat, which a fleet has no use for. It names the
// fleet, says what one is, and hands over a copy-paste `spectro node …` starter
// command plus the read-only spawn dialog. "how it works" points at the dev
// portal's five-lines. Empty or not, entering a fleet now switches the pane.

import { useState } from "react";
import { useLang } from "../state/lang";
import { buildNodeCommand } from "./nodeCommand";

export function FleetHome(props: {
  contextId: string;
  nodeCount: number;
  hubPort: number | null;
  onSpawn: () => void;
}) {
  const de = useLang() === "de";
  const [copied, setCopied] = useState(false);
  const cmd = buildNodeCommand(
    { prompt: "review the open PR", context: props.contextId, role: "worker", id: "", linger: false },
    props.hubPort,
    "ask",
  );
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="fleet-home" data-reveal>
      <div className="fleet-home-inner">
        <p className="fleet-home-eyebrow mono">{de ? "flotte" : "fleet"}</p>
        <h2 className="fleet-home-title mono">{props.contextId}</h2>
        <p className="fleet-home-lead">
          {props.nodeCount === 0
            ? de
              ? "Diese Flotte hat noch keine Nodes. Eine Flotte ist mehrere Agenten, die du zusammen beobachtest — starte Nodes als Prozesse oder aus dem Code, dann erscheinen sie hier und im Graph-Tab."
              : "This fleet has no nodes yet. A fleet is several agents you watch together — start nodes as processes or from code, and they show up here and in the graph tab."
            : de
              ? `${props.nodeCount} Node(s) im Roster. Der Graph-Tab zeigt die Topologie; hier startest du weitere.`
              : `${props.nodeCount} node(s) in the roster. The graph tab shows the topology; start more from here.`}
        </p>

        <div className="fleet-home-card">
          <p className="fleet-home-card-label mono">
            {de ? "einen node starten (terminal)" : "start a node (terminal)"}
          </p>
          <div className="fleet-home-code">
            <code className="mono">{cmd}</code>
            <button type="button" className="fleet-home-copy" onClick={copy}>
              {copied ? (de ? "kopiert" : "copied") : de ? "kopieren" : "copy"}
            </button>
          </div>
          <div className="fleet-home-actions">
            <button type="button" className="fleet-home-spawn" onClick={props.onSpawn}>
              + {de ? "node starten (read-only)" : "spawn a node (read-only)"}
            </button>
            <a className="fleet-home-link" href="https://spectroscope.dev" target="_blank" rel="noreferrer">
              {de ? "wie es funktioniert ↗" : "how it works ↗"}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// The Lab's one-line reading aid under the Flow map. The step controls
// themselves moved to LabTransport (the scrub bar + "now" band, edu port);
// grain + tempo live behind that transport's "advanced" disclosure.

import { useLang } from "../state/lang";

/** The one-line reading aid under the Flow map, per language. */
export function LabHint() {
  const lang = useLang();
  return (
    <p className="lab-hint">
      {lang === "de" ? (
        <>
          Das Coral-Paket wandert pro <span className="mono">Step</span> eine Station weiter —
          links das <span className="mono">Agentensystem</span> (Agent + Betriebssystem), rechts
          die externen Dienste (<span className="mono">LLM</span>, Netz, MCP-Server).
        </>
      ) : (
        <>
          The coral packet moves one station per <span className="mono">Step</span> — the{" "}
          <span className="mono">agent system</span> (agent + operating system) on the left,
          the external services (<span className="mono">LLM</span>, network, MCP server) on the right.
        </>
      )}
    </p>
  );
}

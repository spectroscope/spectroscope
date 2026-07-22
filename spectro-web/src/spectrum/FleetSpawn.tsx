// Start a fleet node from the cockpit. The web spawn is deliberately READ-ONLY —
// the endpoint is browser-reachable, so it must never launch a node that writes
// or runs code. The form is honest about that and hands the operator a copy-paste
// `spectro node …` command for a full-power node, built from the same fields plus
// the live hub port. The FORM is reusable: the fleet canvas shows it as a Panel,
// and the sidebar opens it as a dialog so a fleet can be started from the EMPTY
// state (before any node exists — otherwise the first node is unreachable).

import { useState } from "react";
import { Panel } from "@xyflow/react";
import { useLang } from "../state/lang";
import { buildNodeCommand, type NodePermission, type NodeSpawnFields } from "./nodeCommand";

type SpawnStatus = { kind: "idle" | "spawning" | "ok" | "error"; msg?: string };

/** The spawn form itself. contextId prefills the field (empty = the operator
 *  types the fleet name). onClose collapses the panel or closes the dialog. */
export function FleetSpawnForm(props: { contextId: string; hubPort: number | null; onClose: () => void }) {
  const lang = useLang();
  const de = lang === "de";
  const [fields, setFields] = useState<NodeSpawnFields>({
    prompt: "", context: props.contextId, role: "worker", id: "", linger: false,
  });
  const [cliPerm, setCliPerm] = useState<NodePermission>("ask");
  const [status, setStatus] = useState<SpawnStatus>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof NodeSpawnFields>(k: K, v: NodeSpawnFields[K]): void =>
    setFields((f) => ({ ...f, [k]: v }));
  const cmd = buildNodeCommand(fields, props.hubPort, cliPerm);

  const spawn = async (): Promise<void> => {
    if (!fields.prompt.trim() || !fields.context.trim()) {
      setStatus({ kind: "error", msg: de ? "aufgabe und context sind pflicht" : "task and context are required" });
      return;
    }
    setStatus({ kind: "spawning" });
    try {
      const res = await fetch("/api/fleet/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: fields.prompt,
          context: fields.context.trim(),
          role: fields.role.trim() || undefined,
          id: fields.id.trim() || undefined,
          linger: fields.linger,
        }),
      });
      if (res.status === 202) {
        setStatus({ kind: "ok", msg: de ? "gestartet — erscheint gleich im roster (read-only)" : "spawning — it joins the roster shortly (read-only)" });
        setFields((f) => ({ ...f, prompt: "" }));
      } else if (res.status === 404) {
        // The server 404s uniformly (no enablement oracle), so the client cannot
        // know the exact cause — name the requirements, don't pin one.
        setStatus({ kind: "error", msg: de
          ? "web-spawn nicht verfügbar (braucht SPECTRO_ALLOW_SPAWN, einen laufenden hub und einen erreichbaren node-launcher — siehe server-log). nutze den CLI-befehl unten."
          : "web spawn unavailable (needs SPECTRO_ALLOW_SPAWN, a running hub, and a reachable node launcher — check the server log). use the CLI command below." });
      } else if (res.status === 429) {
        setStatus({ kind: "error", msg: de ? "zu viele spawns — kurz warten" : "too many spawns — wait a moment" });
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({ kind: "error", msg: body.error ?? (de ? "spawn abgelehnt" : "spawn rejected") });
      }
    } catch {
      setStatus({ kind: "error", msg: de ? "server nicht erreichbar" : "server unreachable" });
    }
  };

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(cmd)
      .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };

  return (
    <div className="fleet-spawn-panel">
      <div className="fleet-spawn-head">
        <span className="fleet-spawn-title mono">{de ? "node starten" : "spawn a node"}</span>
        <button type="button" className="fleet-spawn-close" onClick={props.onClose} aria-label={de ? "schließen" : "close"}>×</button>
      </div>

      <label className="fleet-spawn-field">
        <span>{de ? "aufgabe" : "task"}</span>
        <textarea rows={2} value={fields.prompt} onChange={(e) => set("prompt", e.target.value)}
          placeholder={de ? "was soll der node tun?" : "what should the node do?"} />
      </label>
      <div className="fleet-spawn-row">
        <label className="fleet-spawn-field"><span>context</span>
          <input value={fields.context} onChange={(e) => set("context", e.target.value)}
            placeholder={de ? "flotten-name, z. b. pr-42" : "fleet name, e.g. pr-42"} /></label>
        <label className="fleet-spawn-field"><span>role</span>
          <input value={fields.role} onChange={(e) => set("role", e.target.value)} placeholder="worker" /></label>
      </div>
      <div className="fleet-spawn-row">
        <label className="fleet-spawn-field"><span>id</span>
          <input value={fields.id} onChange={(e) => set("id", e.target.value)} placeholder="auto" /></label>
        <label className="fleet-spawn-check">
          <input type="checkbox" checked={fields.linger} onChange={(e) => set("linger", e.target.checked)} /> linger
        </label>
      </div>
      <button type="button" className="fleet-spawn-go" onClick={() => void spawn()} disabled={status.kind === "spawning"}>
        {status.kind === "spawning" ? (de ? "starte…" : "spawning…") : (de ? "read-only starten" : "spawn (read-only)")}
      </button>
      {status.msg && <p className={`fleet-spawn-status fleet-spawn-status--${status.kind}`}>{status.msg}</p>}

      <p className="fleet-spawn-why">
        {de
          ? "read-only, weil dieser endpoint vom browser erreichbar ist: er darf keinen node starten der schreibt oder code ausführt. für einen node mit vollen rechten, im terminal ausführen:"
          : "read-only because this endpoint is browser-reachable: it must not launch a node that writes or runs code. for a node with full rights, run it in your terminal:"}
      </p>
      <div className="fleet-spawn-cli-perm">
        {(["ask", "auto"] as const).map((p) => (
          <button key={p} type="button"
            className={`fleet-spawn-perm${cliPerm === p ? " fleet-spawn-perm--on" : ""}`}
            onClick={() => setCliPerm(p)}>
            {p}
          </button>
        ))}
        <span className="fleet-spawn-perm-hint">{de ? "ask = du bestätigst jedes tool im cockpit" : "ask = you approve each tool in the cockpit"}</span>
      </div>
      <div className="fleet-spawn-cli">
        <code className="mono">{cmd}</code>
        <button type="button" className="fleet-spawn-copy" onClick={copy}>
          {copied ? (de ? "kopiert" : "copied") : (de ? "kopieren" : "copy")}
        </button>
      </div>
    </div>
  );
}

/** The fleet-canvas affordance: a React Flow Panel with a collapsed "+ spawn"
 *  button that opens the form in place. */
export function FleetSpawn(props: { contextId: string; hubPort: number | null }) {
  const de = useLang() === "de";
  const [open, setOpen] = useState(false);
  return (
    <Panel position="top-right" className="fleet-spawn">
      {open ? (
        <FleetSpawnForm contextId={props.contextId} hubPort={props.hubPort} onClose={() => setOpen(false)} />
      ) : (
        <button type="button" className="fleet-spawn-open" onClick={() => setOpen(true)}>
          + {de ? "node starten" : "spawn a node"}
        </button>
      )}
    </Panel>
  );
}

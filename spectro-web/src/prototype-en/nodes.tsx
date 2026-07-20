// The custom React Flow nodes. Each is plain React, so a node can hold ANYTHING —
// including collapsible sections that reveal the untrusted tool input, the system
// context, or the streamed reasoning. That flexibility is exactly why React Flow
// beats a hand-rolled SVG for this view. All styling is design-token based, so
// every node reskins with the 6 genomes; the disk animates via CSS.

import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { JsonTree } from "./JsonTree";
import { NeuralNet } from "./NeuralNet";
import { AluChip, Keyboard, Router } from "./glyphs";
import type { CtxPart } from "./sceneToFlow";
import type { Focus, GateState, SubagentInfo } from "../lab/labScene";

const SIDES = [
  ["l", Position.Left],
  ["r", Position.Right],
  ["t", Position.Top],
  ["b", Position.Bottom],
] as const;

/** Eight invisible handles (source+target per side); edges pick by id. */
function Handles() {
  return (
    <>
      {SIDES.map(([k, pos]) => (
        <Fragment key={k}>
          <Handle id={`${k}s`} type="source" position={pos} isConnectable={false} />
          <Handle id={`${k}t`} type="target" position={pos} isConnectable={false} />
        </Fragment>
      ))}
    </>
  );
}

function Disclosure({ label, children, open: openDefault = false }: { label: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(openDefault);
  return (
    <div className="pf-disc">
      <button className="pf-disc__btn nodrag" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="pf-disc__chev">▸</span>
        {label}
      </button>
      {open && <div className="pf-disc__body nowheel">{children}</div>}
    </div>
  );
}

interface Activity { text: string; color: string; }

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export function UserNode({ data }: NodeProps) {
  const d = data as { active: boolean; prompt: string };
  return (
    <div className={`pf-card pf-user${d.active ? " pf-card--active" : ""}`}>
      <Keyboard active={d.active} />
      <div className="pf-user__name">User</div>
      <div className="pf-user__sub">{d.active ? "typing …" : "PROMPT"}</div>
      {d.prompt && (
        <Disclosure label="Prompt">
          <div className="pf-prose nowheel" style={{ textAlign: "left" }}>{d.prompt}</div>
        </Disclosure>
      )}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent hub
// ---------------------------------------------------------------------------
export function AgentNode({ data }: NodeProps) {
  const d = data as {
    active: boolean; error: boolean; focus: Focus; activity: Activity;
    gate: GateState; gateNote: string; gateColor: string; activeTool: string | null;
    ctxParts: CtxPart[] | null; ctxTotals: { messages: number; estimatedTokens: number; threshold: number } | null;
    prompt: string; systemPrompt: string | null; tool: { name: string; input: unknown } | null;
  };
  const busy = d.focus === "llm" || d.focus === "disk" || d.focus === "cmd" || d.focus === "mcp";
  const tools = ["read_file", "write_file", "list_dir", "run_command"];
  const maxTok = Math.max(1, ...(d.ctxParts ?? []).map((p) => p.estTokens));
  return (
    <div className={`pf-card pf-agent${d.active || busy ? " pf-card--active" : ""}${d.error ? " pf-card--error" : ""}`}>
      <div className="pf-agent__head">
        <div className="pf-agent__title">
          <span className="pf-avatar">◆</span>
          Agent
        </div>
        <span className="pf-status" style={{ color: d.activity.color }}>
          <span className={`pf-status__dot${busy ? " pf-pulse" : ""}`} />
          {d.activity.text}
        </span>
      </div>

      <div className={`pf-row${d.focus === "agent" ? " pf-row--lit" : ""}`}>
        <span className="pf-row__label">Loop</span>
        <span className="pf-row__note">plans · calls tools · reads result</span>
      </div>

      <div className="pf-row" style={{ borderColor: d.gateColor }}>
        <span className="pf-row__label">
          <span className="pf-lock" style={{ color: d.gateColor }} />
          Permission-Gate
        </span>
        <span className="pf-row__note" style={{ color: d.gateColor }}>{d.gateNote}</span>
      </div>

      <div className="pf-eyebrow" style={{ marginTop: 10 }}>Tools</div>
      <div className="pf-tools">
        {tools.map((t) => (
          <span key={t} className={`pf-chip${d.activeTool === t ? " pf-chip--on" : ""}`}>{t}</span>
        ))}
      </div>

      <Disclosure label="System context & current action" open={false}>
        {d.systemPrompt && (
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">System prompt</div>
            <div className="pf-prose nowheel" style={{ textAlign: "left" }}>{d.systemPrompt}</div>
          </div>
        )}
        {d.ctxParts && d.ctxTotals && (
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">Context to the LLM · {d.ctxTotals.estimatedTokens.toLocaleString()} / {d.ctxTotals.threshold.toLocaleString()} tok</div>
            <div className="pf-ctx">
              {d.ctxParts.map((p) => (
                <div className="pf-ctx__row" key={p.label}>
                  <span>{p.label}</span>
                  <span className="pf-ctx__bar"><span className="pf-ctx__fill" style={{ width: `${(p.estTokens / maxTok) * 100}%` }} /></span>
                  <span className="pf-ctx__tok">{p.estTokens}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {d.tool ? (
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">Tool call · {d.tool.name}</div>
            <div className="nowheel" style={{ maxHeight: 150, overflow: "auto" }}>
              <JsonTree data={d.tool.input} />
            </div>
          </div>
        ) : (
          <div className="pf-kv">No tool active, the agent is planning.</div>
        )}
      </Disclosure>

      <Handles />
    </div>
  );
}

/** An animated spinning globe for the network node — meridians rotate and a
 *  signal packet orbits when the network is in use (same live spirit as the
 *  LLM neural net). Idle = a calm static globe. */
function NetGlobe({ active }: { active: boolean }) {
  return (
    <div className={`pf-globe${active ? " pf-globe--on" : ""}`}>
      <svg viewBox="0 0 44 44" width="40" height="40" aria-hidden="true">
        <circle className="pf-globe__rim" cx="22" cy="22" r="15" />
        <path className="pf-globe__lat" d="M10 16 H34" />
        <line className="pf-globe__lat" x1="7" y1="22" x2="37" y2="22" />
        <path className="pf-globe__lat" d="M10 28 H34" />
        <line className="pf-globe__axis" x1="22" y1="7" x2="22" y2="37" />
        <ellipse className="pf-globe__mer pf-globe__mer1" cx="22" cy="22" rx="15" ry="15" />
        <ellipse className="pf-globe__mer pf-globe__mer2" cx="22" cy="22" rx="8" ry="15" />
        <g className="pf-globe__orbit">
          <circle className="pf-globe__packet" cx="22" cy="7" r="1.9" />
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OS band nodes (disk / shell / net / mcp-client)
// ---------------------------------------------------------------------------
export function OsNode({ data }: NodeProps) {
  const d = data as {
    kind: "disk" | "shell" | "net" | "mcp"; active: boolean;
    disk?: "idle" | "read" | "write"; file?: string | null;
    command?: string | null; mcp?: string | null; tool?: { name: string; input: unknown } | null;
  };

  let title = "";
  let body: ReactNode = null;
  if (d.kind === "disk") {
    title = "Disk";
    body = (
      <>
        <div className="pf-disk" data-disk={d.disk}>
          <svg width="76" height="54" viewBox="0 0 76 54">
            <circle className="pf-ripple" cx="30" cy="30" r="12" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
            <g className="pf-platter">
              <circle cx="30" cy="30" r="16" fill="var(--surface-3)" stroke="var(--border-strong)" strokeWidth="1.5" />
              <circle cx="30" cy="30" r="10" fill="none" stroke="var(--border-strong)" />
              <circle cx="30" cy="30" r="2" fill="var(--border-strong)" />
              <circle cx="30" cy="17" r="1.8" fill="var(--accent)" />
            </g>
            <g className="pf-arm">
              <line x1="58" y1="12" x2="40" y2="26" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" />
              <circle cx="58" cy="12" r="2.6" fill="var(--text-dim)" />
            </g>
          </svg>
        </div>
        {d.disk && d.disk !== "idle" && (
          <div className={`pf-filepill${d.disk === "write" ? " pf-filepill--write" : ""}`}>{d.file ?? "file"}</div>
        )}
      </>
    );
  } else if (d.kind === "shell") {
    title = "Shell";
    const shown = d.command ? (d.command.length > 26 ? `${d.command.slice(0, 25)}…` : d.command) : "";
    body = (
      <>
        <div className={`pf-shell${d.active ? " pf-shell--on" : ""}`}>
          <span className="pf-shell__prompt">$</span>
          {shown
            ? <span key={shown} className="pf-shell__cmd" style={{ "--n": shown.length } as CSSProperties}>{shown}</span>
            : <span className="pf-shell__idle">idle</span>}
          <span className="pf-shell__cursor" />
        </div>
        {d.command && (
          <Disclosure label="Command">
            <div className="pf-panelbox pf-mono nowheel" style={{ fontSize: 11, overflow: "auto", maxHeight: 90 }}>$ {d.command}</div>
          </Disclosure>
        )}
      </>
    );
  } else if (d.kind === "net") {
    title = "Network";
    body = <NetGlobe active={d.active} />;
  } else {
    title = "MCP-Client";
    body = (
      <>
        <div className={`pf-os__line${d.active ? " pf-os__line--on" : ""}`}>{d.mcp ?? "idle"}</div>
        {d.tool && (
          <Disclosure label="MCP call">
            <div className="pf-panelbox">
              <div className="pf-panelbox__label">{d.tool.name}</div>
              <div className="nowheel" style={{ maxHeight: 130, overflow: "auto" }}>
                <JsonTree data={d.tool.input} />
              </div>
            </div>
          </Disclosure>
        )}
      </>
    );
  }

  return (
    <div className={`pf-card pf-os pf-os--${d.kind}${d.active ? " pf-card--active" : ""}`}>
      <div className="pf-os__head">
        <span className="pf-eyebrow">{title}</span>
      </div>
      {body}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------
export function LlmNode({ data }: NodeProps) {
  const d = data as { active: boolean; local: boolean; provider: string; model: string; think: string; answer: string };
  return (
    <div className={`pf-card pf-llm${d.active ? " pf-card--active pf-llm--active" : ""}`}>
      <div className="pf-llm__halo" />
      <div className="pf-llm__net"><NeuralNet active={d.active} /></div>
      <div className="pf-llm__name">LLM</div>
      <div className="pf-llm__model">{d.model || d.provider}</div>
      <div className="pf-llm__loc"><b>{d.local ? "local" : "remote"}</b> · {d.provider}</div>
      {(d.think || d.answer) && (
        <Disclosure label="Reasoning & answer">
          {d.think && (
            <div className="pf-panelbox" style={{ textAlign: "left" }}>
              <div className="pf-panelbox__label">Thinking</div>
              <div className="pf-prose nowheel">{d.think}</div>
            </div>
          )}
          {d.answer && (
            <div className="pf-panelbox" style={{ textAlign: "left" }}>
              <div className="pf-panelbox__label">Answer</div>
              <div className="pf-prose nowheel">{d.answer}</div>
            </div>
          )}
        </Disclosure>
      )}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// External services (Netz / MCP-Server)
// ---------------------------------------------------------------------------
export function ExtNode({ data }: NodeProps) {
  const d = data as { kind: "netz" | "mcpserver"; active: boolean; mcp?: string | null };
  if (d.kind === "netz") {
    return (
      <div className={`pf-card pf-ext pf-ext--center${d.active ? " pf-card--active" : ""}`}>
        <div className="pf-ext__head">Net</div>
        <Router active={d.active} />
        <div className={`pf-ext__sub${d.active ? " pf-ext__sub--on" : ""}`}>Routing · Internet</div>
        <Handles />
      </div>
    );
  }
  return (
    <div className={`pf-card pf-ext pf-ext--center${d.active ? " pf-card--active" : ""}`}>
      <div className="pf-ext__head">MCP-Server</div>
      <AluChip active={d.active} />
      <div className={`pf-ext__sub${d.active ? " pf-ext__sub--on" : ""}`}>{d.mcp ?? "external server"}</div>
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagent loop
// ---------------------------------------------------------------------------
export function SubagentNode({ data }: NodeProps) {
  const d = data as {
    id: string; label: string | null; task: string; state: SubagentInfo["state"];
    stateLabel: string; stateColor: string; lastStatus: string | null; activity: Activity;
    focus: Focus; active: boolean; think: string;
  };
  return (
    <div className={`pf-card pf-sub${d.active ? " pf-card--active" : ""}`}>
      <div className="pf-sub__head">
        <span className="pf-sub__id">
          <span className="pf-sub__dot" style={{ background: d.stateColor }} />
          {d.label ? `${d.label} · ${d.id}` : d.id}
        </span>
        <span className="pf-badge" style={{ color: d.stateColor }}>{d.stateLabel}</span>
      </div>
      <div className="pf-sub__task">{d.task}</div>
      <div className="pf-sub__status" style={{ color: d.activity.color }}>
        <span className={`pf-status__dot${d.focus === "llm" ? " pf-pulse" : ""}`} />
        {d.activity.text}
      </div>
      {(d.lastStatus || d.think) && (
        <Disclosure label="Task & history">
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">Task</div>
            <div className="pf-prose nowheel">{d.task}</div>
          </div>
          {d.lastStatus && <div className="pf-kv">Last status: <b>{d.lastStatus}</b></div>}
        </Disclosure>
      )}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone (non-interactive background container)
// ---------------------------------------------------------------------------
export function ZoneNode({ data }: NodeProps) {
  const d = data as { variant: "mac" | "os" | "outside" | "boundary"; label: string };
  if (d.variant === "boundary") {
    return (
      <div className="pf-boundary">
        <span className="pf-boundary__tag">{d.label}</span>
      </div>
    );
  }
  return (
    <div className={`pf-zone pf-zone--${d.variant}`}>
      <div className="pf-zone__eyebrow">
        <span className="pf-diamond" />
        {d.label}
      </div>
    </div>
  );
}

export const nodeTypes = {
  zone: ZoneNode,
  user: UserNode,
  agent: AgentNode,
  os: OsNode,
  llm: LlmNode,
  ext: ExtNode,
  subagent: SubagentNode,
};

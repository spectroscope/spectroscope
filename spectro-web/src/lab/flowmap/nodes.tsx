// The custom React Flow nodes. Each is plain React, so a node can hold ANYTHING —
// including collapsible sections that reveal the untrusted tool input, the system
// context, or the streamed reasoning. That flexibility is exactly why React Flow
// beats a hand-rolled SVG for this view. All styling is design-token based, so
// every node reskins with the 6 genomes; the disk animates via CSS.

import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { JsonTree } from "../../components/JsonTree";
import { NeuralNet } from "./NeuralNet";
import { AluChip, Keyboard, Router } from "./glyphs";
import type { AgentStream, CtxPart } from "./sceneToFlow";
import type { Focus, GateState, SubagentInfo } from "../labScene";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";

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

/** The tool chips the agent hub shows (the standard tool belt). */
const AGENT_TOOL_CHIPS = ["read_file", "write_file", "list_dir", "run_command"];

/** The shell's one-line display clips a running command to this width. */
const SHELL_PREVIEW_CHARS = 26;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export function UserNode({ data }: NodeProps) {
  const d = data as { active: boolean; prompt: string };
  const lang = useLang();
  return (
    <div className={`pf-card pf-user${d.active ? " pf-card--active" : ""}`}>
      <Keyboard active={d.active} />
      <div className="pf-user__name">User</div>
      <div className="pf-user__sub">{d.active ? t(lang, "map.user.typing") : "PROMPT"}</div>
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
  const lang = useLang();
  const busy = d.focus === "llm" || d.focus === "disk" || d.focus === "cmd" || d.focus === "mcp";
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
        <span className="pf-row__note">{t(lang, "map.loop.note")}</span>
      </div>

      <div className="pf-row" style={{ borderColor: d.gateColor }}>
        <span className="pf-row__label">
          <span className="pf-lock" style={{ color: d.gateColor }} />
          {t(lang, "map.node.gate")}
        </span>
        <span className="pf-row__note" style={{ color: d.gateColor }}>{d.gateNote}</span>
      </div>

      <div className="pf-eyebrow" style={{ marginTop: 10 }}>Tools</div>
      <div className="pf-tools">
        {AGENT_TOOL_CHIPS.map((tool) => (
          <span key={tool} className={`pf-chip${d.activeTool === tool ? " pf-chip--on" : ""}`}>{tool}</span>
        ))}
      </div>

      <Disclosure label={t(lang, "map.disc.context")} open={false}>
        {d.systemPrompt && (
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">{t(lang, "map.ctx.systemPrompt")}</div>
            <div className="pf-prose nowheel" style={{ textAlign: "left" }}>{d.systemPrompt}</div>
          </div>
        )}
        {d.ctxParts && d.ctxTotals && (
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">{t(lang, "map.ctx.toLlm")} · {d.ctxTotals.estimatedTokens.toLocaleString()} / {d.ctxTotals.threshold.toLocaleString()} tok</div>
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
            <div className="pf-panelbox__label">{t(lang, "map.ctx.toolCall")} · {d.tool.name}</div>
            <div className="nowheel" style={{ maxHeight: 150, overflow: "auto" }}>
              <JsonTree value={d.tool.input} defaultDepth={3} />
            </div>
          </div>
        ) : (
          <div className="pf-kv">{t(lang, "map.ctx.noTool")}</div>
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
// OS band nodes (disk / shell / net / mcp-client) — one shared card frame,
// one self-contained body component per kind.
// ---------------------------------------------------------------------------

/** The spinning platter plus the file pill while a read/write is on it. */
function DiskBody({ disk, file }: { disk?: "idle" | "read" | "write"; file?: string | null }) {
  const lang = useLang();
  return (
    <>
      <div className="pf-disk" data-disk={disk}>
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
      {disk && disk !== "idle" && (
        <div className={`pf-filepill${disk === "write" ? " pf-filepill--write" : ""}`}>{file ?? t(lang, "map.act.file")}</div>
      )}
    </>
  );
}

/** The prompt line typing the running command, plus its full-text disclosure. */
function ShellBody({ command, active }: { command?: string | null; active: boolean }) {
  const lang = useLang();
  const shown = command
    ? (command.length > SHELL_PREVIEW_CHARS ? `${command.slice(0, SHELL_PREVIEW_CHARS - 1)}…` : command)
    : "";
  return (
    <>
      <div className={`pf-shell${active ? " pf-shell--on" : ""}`}>
        <span className="pf-shell__prompt">$</span>
        {shown
          ? <span key={shown} className="pf-shell__cmd" style={{ "--n": shown.length } as CSSProperties}>{shown}</span>
          : <span className="pf-shell__idle">{t(lang, "map.gate.none")}</span>}
        <span className="pf-shell__cursor" />
      </div>
      {command && (
        <Disclosure label={t(lang, "map.shell.cmd")}>
          <div className="pf-panelbox pf-mono nowheel" style={{ fontSize: 11, overflow: "auto", maxHeight: 90 }}>$ {command}</div>
        </Disclosure>
      )}
    </>
  );
}

/** The active MCP call line plus its JSON disclosure. */
function McpBody({ active, mcp, tool }: { active: boolean; mcp?: string | null; tool?: { name: string; input: unknown } | null }) {
  const lang = useLang();
  return (
    <>
      <div className={`pf-os__line${active ? " pf-os__line--on" : ""}`}>{mcp ?? t(lang, "map.gate.none")}</div>
      {tool && (
        <Disclosure label={t(lang, "map.mcp.call")}>
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">{tool.name}</div>
            <div className="nowheel" style={{ maxHeight: 130, overflow: "auto" }}>
              <JsonTree value={tool.input} defaultDepth={3} />
            </div>
          </div>
        </Disclosure>
      )}
    </>
  );
}

export function OsNode({ data }: NodeProps) {
  const d = data as {
    kind: "disk" | "shell" | "net" | "mcp"; active: boolean;
    disk?: "idle" | "read" | "write"; file?: string | null;
    command?: string | null; mcp?: string | null; tool?: { name: string; input: unknown } | null;
  };
  const lang = useLang();

  let station: { title: string; body: ReactNode };
  switch (d.kind) {
    case "disk":
      station = { title: "Disk", body: <DiskBody disk={d.disk} file={d.file} /> };
      break;
    case "shell":
      station = { title: "Shell", body: <ShellBody command={d.command} active={d.active} /> };
      break;
    case "net":
      station = { title: t(lang, "map.node.network"), body: <NetGlobe active={d.active} /> };
      break;
    case "mcp":
      station = { title: "MCP-Client", body: <McpBody active={d.active} mcp={d.mcp} tool={d.tool} /> };
      break;
  }

  return (
    <div className={`pf-card pf-os pf-os--${d.kind}${d.active ? " pf-card--active" : ""}`}>
      <div className="pf-os__head">
        <span className="pf-eyebrow">{station.title}</span>
      </div>
      {station.body}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------
export function LlmNode({ data }: NodeProps) {
  const d = data as { active: boolean; local: boolean; provider: string; model: string; think: AgentStream[]; answer: AgentStream[] };
  const lang = useLang();
  // One shared model, many callers: every agent's stream renders as its own
  // marked entry — subagents indented and tinted so the interleaving reads.
  const section = (label: string, streams: AgentStream[]) =>
    streams.length > 0 ? (
      <div className="pf-panelbox" style={{ textAlign: "left" }}>
        <div className="pf-panelbox__label">{label}</div>
        <div className="pf-llm__streams nowheel">
          {streams.map((s) => (
            <div key={s.agent} className={`pf-llm__stream${s.agent === "main" ? "" : " is-sub"}`}>
              <span className="pf-llm__agent">{s.agent}</span>
              <div className="pf-prose">{s.text}</div>
            </div>
          ))}
        </div>
      </div>
    ) : null;
  return (
    <div className={`pf-card pf-llm${d.active ? " pf-card--active pf-llm--active" : ""}`}>
      <div className="pf-llm__halo" />
      <div className="pf-llm__net"><NeuralNet active={d.active} /></div>
      <div className="pf-llm__name">LLM</div>
      <div className="pf-llm__model">{d.model || d.provider}</div>
      <div className="pf-llm__loc"><b>{d.local ? t(lang, "map.local") : t(lang, "map.remote")}</b> · {d.provider}</div>
      {(d.think.length > 0 || d.answer.length > 0) && (
        <Disclosure label={t(lang, "map.llm.reasoning")}>
          {section("Thinking", d.think)}
          {section(t(lang, "map.llm.answer"), d.answer)}
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
  const lang = useLang();
  if (d.kind === "netz") {
    return (
      <div className={`pf-card pf-ext pf-ext--center${d.active ? " pf-card--active" : ""}`}>
        <div className="pf-ext__head">{t(lang, "map.node.netz")}</div>
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
      <div className={`pf-ext__sub${d.active ? " pf-ext__sub--on" : ""}`}>{d.mcp ?? t(lang, "map.extServer")}</div>
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagent loop
// ---------------------------------------------------------------------------
export function SubagentNode({ data }: NodeProps) {
  const lang = useLang();
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
        <Disclosure label={t(lang, "map.sub.disc")}>
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">{t(lang, "map.sub.order")}</div>
            <div className="pf-prose nowheel">{d.task}</div>
          </div>
          {d.lastStatus && <div className="pf-kv">{t(lang, "map.sub.lastStatus")} <b>{d.lastStatus}</b></div>}
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

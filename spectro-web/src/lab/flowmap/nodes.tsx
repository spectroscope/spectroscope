// The custom React Flow nodes. Each is plain React, so a node can hold ANYTHING —
// including collapsible sections that reveal the untrusted tool input, the system
// context, or the streamed reasoning. That flexibility is exactly why React Flow
// beats a hand-rolled SVG for this view. All styling is design-token based, so
// every node reskins with the 6 genomes; the disk animates via CSS.

import { useContext, useState, type CSSProperties, type ReactNode } from "react";
import { type NodeProps } from "@xyflow/react";
import { Handles } from "./handles";
import { ExpandAllContext } from "./expandContext";
import { ToolCallPanel } from "./ToolCallPanel";
import { NeuralNet } from "./NeuralNet";
import { AluChip, Keyboard, Router } from "./glyphs";
import { agentBelt, launchScript, LAUNCH_SCRIPT_NOTE } from "./belt";
import type { AgentStream, CtxPart, McpAnswerView, NetCardView } from "./sceneToFlow";
import { SHELL_COMMAND_KEY, type Focus, type GateState, type SubagentInfo } from "../labScene";
import { blockLang } from "../../components/toolViews";
import { breakShellChain } from "../../components/shellChain";
import { highlight } from "../../components/Highlighted";
import { WorkflowBoxNode } from "./WorkflowBoxNode";
import { recordedUrlState, redactionRule } from "./addresses";
import { screenshotUrl } from "../../wire/browserWire";
import { formatDuration } from "../../format";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";

function Disclosure({
  label,
  children,
  open: openDefault = false,
}: {
  label: string;
  children: ReactNode;
  open?: boolean;
}) {
  const expandAll = useContext(ExpandAllContext);
  const [open, setOpen] = useState(openDefault || expandAll);
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

interface Activity {
  text: string;
  color: string;
}

/** Why the launch chips look different: hovering one has to say the difference,
 *  because the difference is the whole reason they are a separate kind. */
const LAUNCH_TITLE = "a background task — this session holds the launch, not the run";

/** A tiny "generated image" thumbnail (a placeholder, not a real asset) shown
 *  when the agent's active tool is generate_image. */
/** The generated image: the REAL blob when it exists (GET /api/images/<file>),
 *  the gradient placeholder while generating — or when the blob is gone
 *  (scripted sessions, cleaned stores): onError swaps back to the placeholder,
 *  so a missing file never renders as a broken-image glyph. */
function GenImage({ src, alt }: { src?: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (src !== undefined && !broken) {
    return (
      <img
        className="pf-genimg"
        width={72}
        height={48}
        style={{ objectFit: "cover" }}
        src={src}
        alt={alt ?? ""}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <svg className="pf-genimg" width="72" height="48" viewBox="0 0 72 48" aria-hidden="true">
      <defs>
        <linearGradient id="pf-gi" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--sp-ocean)" />
          <stop offset="0.5" stopColor="var(--sp-violet)" />
          <stop offset="1" stopColor="var(--sp-amber)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="70" height="46" rx="4" fill="url(#pf-gi)" opacity="0.85" />
      <circle cx="20" cy="18" r="6" fill="var(--surface)" opacity="0.7" />
      <path d="M6 42 L26 24 L38 34 L52 18 L66 42 Z" fill="var(--surface)" opacity="0.5" />
    </svg>
  );
}

/** The shell's one-line display clips a running command to this width. */
const SHELL_PREVIEW_CHARS = 26;
/** The widened expanded station (card 287) fits a longer preview. */
const SHELL_PREVIEW_CHARS_WIDE = 48;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export function UserNode({ data }: NodeProps) {
  const d = data as { active: boolean; prompt: string };
  const lang = useLang();
  const expandAll = useContext(ExpandAllContext);

  // edu: the prompt sits BESIDE the user, in a column (like the agent card).
  if (expandAll && d.prompt) {
    return (
      <div className={`pf-card pf-user pf-user--wide${d.active ? " pf-card--active" : ""}`}>
        <div className="pf-user__col">
          <Keyboard active={d.active} />
          <div className="pf-user__name">User</div>
          <div className="pf-user__sub">{d.active ? t(lang, "map.user.typing") : "PROMPT"}</div>
        </div>
        <div className="pf-user__prompt">
          <div className="pf-eyebrow">prompt</div>
          <div className="pf-prose nowheel" style={{ textAlign: "left" }}>
            {d.prompt}
          </div>
        </div>
        <Handles />
      </div>
    );
  }

  return (
    <div className={`pf-card pf-user${d.active ? " pf-card--active" : ""}`}>
      <Keyboard active={d.active} />
      <div className="pf-user__name">User</div>
      <div className="pf-user__sub">{d.active ? t(lang, "map.user.typing") : "PROMPT"}</div>
      {d.prompt && (
        <Disclosure label="Prompt">
          <div className="pf-prose nowheel" style={{ textAlign: "left" }}>
            {d.prompt}
          </div>
        </Disclosure>
      )}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent hub
// ---------------------------------------------------------------------------
export type AgentData = {
  active: boolean;
  error: boolean;
  focus: Focus;
  activity: Activity;
  gate: GateState;
  gateNote: string;
  gateColor: string;
  activeTool: string | null;
  ctxParts: CtxPart[] | null;
  ctxTotals: { messages: number; estimatedTokens: number; threshold: number } | null;
  prompt: string;
  systemPrompt: string | null;
  tool: { name: string; input: unknown } | null;
  genImage: { src: string; prompt: string } | null;
  attached: { src: string; note: string }[] | null;
};

/** The agent card's inner content — head, loop and gate rows, the tool belt
 *  and the context panels — WITHOUT the outer card frame and WITHOUT handles.
 *  Extracted so the expanded worker card renders the same instrument with the
 *  child's own data (card 287); AgentNode below is the frame around it. */
export function AgentCardBody({
  data: d,
  scrollShelf = false,
  budget = true,
}: {
  data: AgentData;
  /** The worker card caps its picture shelf (card 296), so the shelf is a
   *  scroll region and needs the canvas to keep its hands off it. */
  scrollShelf?: boolean;
  /**
   * CARD 319 — hold every region's room whether it is carrying anything or
   * not, so stepping the run cannot change the card's box.
   *
   * The owner: "maybe plan the maximum space for the commands from the start,
   * so you say: a command is at most this long, and that size is budgeted into
   * the main agent card from the beginning." Measured over his own 3328 steps,
   * the card's height changed on 931 of them across a 569px swing, and the
   * tool-call panel — created on `tool_call`, destroyed on `tool_result` —
   * was 929 of those 931 changes.
   *
   * The HUB budgets; the worker card does not. Its own height is a measured
   * bound (cardGeometry.ts, card 296) that the whole worker grid is seated
   * from, so giving it the hub's reserves would move every seat on the map for
   * a card nobody complained about. Off for the worker, and it renders exactly
   * what it rendered before.
   *
   * Applies to the expanded card only (`budgeted` is `budget && expandAll`).
   * Compact holds all of this inside a disclosure that ARRIVES SHUT, and in
   * that state was measured at one height across the whole recording. Opened it
   * moves again — 420.06 / 547.88 / 664.97 / 703.02 over the same walk, eleven
   * times — which is a card card 319 did not budget, not a card that cannot
   * move.
   */
  budget?: boolean;
}) {
  const lang = useLang();
  const expandAll = useContext(ExpandAllContext);
  const budgeted = budget && expandAll;
  const busy = d.focus === "llm" || d.focus === "disk" || d.focus === "cmd" || d.focus === "mcp";
  const maxTok = Math.max(1, ...(d.ctxParts ?? []).map((p) => p.estTokens));

  const head = (
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
  );
  const loopRow = (
    <div className={`pf-row${d.focus === "agent" ? " pf-row--lit" : ""}`}>
      <span className="pf-row__label">Loop</span>
      <span className="pf-row__note">{t(lang, "map.loop.note")}</span>
    </div>
  );
  const gateRow = (
    <div className="pf-row" style={{ borderColor: d.gateColor }}>
      <span className="pf-row__label">
        <span className="pf-lock" style={{ color: d.gateColor }} />
        {t(lang, "map.node.gate")}
      </span>
      <span className="pf-row__note" style={{ color: d.gateColor }}>
        {d.gateNote}
      </span>
    </div>
  );
  // The belt, and — while a launch is on it — what that launch's script says it
  // is made of. The phase list is the script's own header and is labelled as
  // that: the agents that would run those phases are in other runs with other
  // streams, so this session can say a workflow STARTED and never that a phase
  // finished (card 146).
  const belt = agentBelt(d.activeTool);
  const launching = belt.some((c) => c.on && c.kind === "launch");
  const script = launchScript(d.tool);
  const toolsBlock = (
    <>
      <div className="pf-eyebrow" style={{ marginTop: 10 }}>
        Tools
      </div>
      <div className="pf-tools nowheel">
        {belt.map((c) => (
          <span
            key={c.name}
            className={`pf-chip pf-chip--${c.kind}${c.on ? " pf-chip--on" : ""}`}
            title={
              c.kind === "launch"
                ? LAUNCH_TITLE
                : c.kind === "foreign"
                  ? t(lang, "map.tools.foreign")
                  : undefined
            }
          >
            {c.kind === "launch" && (
              <span className="pf-chip__fan" aria-hidden="true">
                ⇉
              </span>
            )}
            {c.name}
          </span>
        ))}
      </div>
      {launching && (
        <div className="pf-phases">
          <div className="pf-eyebrow">phases · declared, not observed</div>
          {script.state === "declared" ? (
            <ol className="pf-phases__list nowheel">
              {script.phases.map((p, i) => (
                <li className="pf-phases__item" key={`${p}-${i}`}>
                  {p}
                </li>
              ))}
            </ol>
          ) : (
            <div className="pf-phases__none">{LAUNCH_SCRIPT_NOTE[script.state]}</div>
          )}
        </div>
      )}
    </>
  );
  // a generated image has no competing right-column JSON, so in the wide edu
  // layout it spans BOTH columns (full card width) — the prompt reads clearly.
  const isGenImage = d.tool?.name === "generate_image";
  // The three ctx-column panels. A budgeted card renders all three on every
  // step, carrying or not: a panel that comes and goes IS the card changing
  // size, and no fixed height on the card can hide that.
  const sysPanel =
    d.systemPrompt || budgeted ? (
      <div className="pf-panelbox">
        <div className="pf-panelbox__label" title={t(lang, "map.ctx.systemPrompt")}>
          {t(lang, "map.ctx.systemPrompt")}
        </div>
        <div className="pf-prose nowheel" style={{ textAlign: "left" }}>
          {d.systemPrompt ? d.systemPrompt : t(lang, "map.ctx.noSystemPrompt")}
        </div>
      </div>
    ) : null;
  const ctxLabel =
    d.ctxTotals === null
      ? t(lang, "map.ctx.toLlm")
      : `${t(lang, "map.ctx.toLlm")} · ${d.ctxTotals.estimatedTokens.toLocaleString()} / ` +
        `${d.ctxTotals.threshold.toLocaleString()} tok`;
  const ctxBarsPanel =
    (d.ctxParts && d.ctxTotals) || budgeted ? (
      <div className="pf-panelbox nowheel">
        <div className="pf-panelbox__label" title={ctxLabel}>
          {ctxLabel}
        </div>
        <div className="pf-ctx nowheel">
          {/* The empty line sits AFTER the bars, not before them: the growth-
              region derivation credits a `.map(` to the nearest classed element
              above it, and a placeholder above the bars would have this region
              reported as `.pf-kv` — a wrong answer wearing a right one's face. */}
          {(d.ctxParts ?? []).map((p) => (
            <div className="pf-ctx__row" key={p.label}>
              <span>{p.label}</span>
              <span className="pf-ctx__bar">
                <span className="pf-ctx__fill" style={{ width: `${(p.estTokens / maxTok) * 100}%` }} />
              </span>
              <span className="pf-ctx__tok">{p.estTokens}</span>
            </div>
          ))}
          {d.ctxParts === null && <div className="pf-kv">{t(lang, "map.ctx.noContext")}</div>}
        </div>
      </div>
    ) : null;
  const genImagePanel =
    d.tool && isGenImage ? (
      // in flight: the placeholder + the requested prompt
      <div className="pf-panelbox pf-genimg-panel">
        <div className="pf-panelbox__label" title={`${t(lang, "map.ctx.toolCall")} · ${d.tool.name}`}>
          {t(lang, "map.ctx.toolCall")} · {d.tool.name}
        </div>
        <div className="pf-genimg-wrap">
          <GenImage />
          <span className="pf-genimg-cap">
            {String((d.tool.input as { prompt?: string })?.prompt ?? "a generated image")}
          </span>
        </div>
      </div>
    ) : d.genImage ? (
      // done: the REAL image off the store (falls back to the placeholder
      // when the blob is gone — scripted sessions, cleaned stores)
      <div className="pf-panelbox pf-genimg-panel">
        <div className="pf-panelbox__label" title={t(lang, "map.ctx.genImage")}>
          {t(lang, "map.ctx.genImage")}
        </div>
        <div className="pf-genimg-wrap">
          <GenImage src={d.genImage.src} alt={d.genImage.prompt} />
          <span className="pf-genimg-cap">{d.genImage.prompt}</span>
        </div>
      </div>
    ) : null;
  // What the agent was HANDED. Separate from the generated panel above on
  // purpose: same shelf, different provenance, and the label says which.
  const attachedPanel =
    d.attached && d.attached.length > 0 ? (
      <div className="pf-panelbox pf-genimg-panel">
        <div className="pf-panelbox__label" title={`${t(lang, "map.ctx.attached")} · ${d.attached.length}`}>
          {t(lang, "map.ctx.attached")} · {d.attached.length}
        </div>
        <div className="pf-shots nowheel">
          {d.attached.map((shot, i) => (
            <figure className="pf-shot" key={`${shot.note}-${i}`}>
              <img className="pf-genimg" src={shot.src} alt={shot.note} />
              <figcaption className="pf-genimg-cap">{shot.note}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    ) : null;
  // Two-faced since card 120: the insight tree or the call as the thing it is,
  // under the map's master face with a per-panel strip on top.
  // Budgeted, the panel is always there and holds its own body height, so a
  // call starting cannot grow the card and its answer cannot shrink it. It
  // then carries a `generate_image` call too — unbudgeted that call is routed
  // to the picture panel alone, but "no tool active" printed while one runs
  // would be a card that lies, which is worse than a card that repeats itself.
  const toolPanel = budgeted || (d.tool !== null && !isGenImage) ? <ToolCallPanel tool={d.tool} /> : null;
  const noToolPanel = budgeted || d.tool ? null : <div className="pf-kv">{t(lang, "map.ctx.noTool")}</div>;
  // stacked (simulator / collapsed): everything inline, the image among the rest.
  const ctxPanels = (
    <>
      {sysPanel}
      {ctxBarsPanel}
      {genImagePanel}
      {attachedPanel}
      {toolPanel}
      {noToolPanel}
    </>
  );

  return (
    <>
      {head}
      {expandAll ? (
        // edu: the context sits BESIDE the controls (wider card, not a tall stack).
        // A generated image spans both columns underneath — no JSON competes with it.
        <>
          <div className="pf-agent__cols">
            <div className="pf-agent__main">
              {loopRow}
              {gateRow}
              {toolsBlock}
            </div>
            <div className="pf-agent__ctx">
              <div className="pf-eyebrow">{t(lang, "map.disc.context")}</div>
              {sysPanel}
              {ctxBarsPanel}
              {toolPanel}
              {noToolPanel}
            </div>
          </div>
          {budgeted ? (
            // The picture strip, reserved. It holds its room from the first
            // frame, so the shelf arriving on step 4 cannot move the card —
            // measured, the six pictures the hub is allowed to hold stack
            // 330.9px and stay, which is a floor-raise rather than a flicker
            // but a floor-raise the owner still watches happen. The eyebrow
            // sits OUTSIDE the scroller so it does not scroll away with the
            // pictures, and the scroller is what the canvas keeps its hands
            // off.
            <div className="pf-agent__genfull">
              <div className="pf-eyebrow">{t(lang, "map.ctx.pictures")}</div>
              <div className="pf-agent__shelf nowheel nodrag">
                {genImagePanel}
                {attachedPanel}
                {genImagePanel === null && attachedPanel === null && (
                  <div className="pf-kv">{t(lang, "map.ctx.noPictures")}</div>
                )}
              </div>
            </div>
          ) : (
            (genImagePanel || attachedPanel) && (
              <div className={`pf-agent__genfull${scrollShelf ? " nowheel nodrag" : ""}`}>
                {genImagePanel}
                {attachedPanel}
              </div>
            )
          )}
        </>
      ) : (
        <>
          {loopRow}
          {gateRow}
          {toolsBlock}
          <Disclosure label={t(lang, "map.disc.context")} open={false}>
            {ctxPanels}
          </Disclosure>
        </>
      )}
    </>
  );
}

export function AgentNode({ data }: NodeProps) {
  const d = data as AgentData;
  const expandAll = useContext(ExpandAllContext);
  const busy = d.focus === "llm" || d.focus === "disk" || d.focus === "cmd" || d.focus === "mcp";
  return (
    <div
      className={`pf-card pf-agent${d.active || busy ? " pf-card--active" : ""}${d.error ? " pf-card--error" : ""}${expandAll ? " pf-agent--wide" : ""}`}
    >
      <AgentCardBody data={d} />
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
          <circle
            className="pf-ripple"
            cx="30"
            cy="30"
            r="12"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.2"
          />
          <g className="pf-platter">
            <circle
              cx="30"
              cy="30"
              r="16"
              fill="var(--surface-3)"
              stroke="var(--border-strong)"
              strokeWidth="1.5"
            />
            <circle cx="30" cy="30" r="10" fill="none" stroke="var(--border-strong)" />
            <circle cx="30" cy="30" r="2" fill="var(--border-strong)" />
            <circle cx="30" cy="17" r="1.8" fill="var(--accent)" />
          </g>
          <g className="pf-arm">
            <line
              x1="58"
              y1="12"
              x2="40"
              y2="26"
              stroke="var(--text-dim)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="58" cy="12" r="2.6" fill="var(--text-dim)" />
          </g>
        </svg>
      </div>
      {disk && disk !== "idle" && (
        <div className={`pf-filepill${disk === "write" ? " pf-filepill--write" : ""}`}>
          {file ?? t(lang, "map.act.file")}
        </div>
      )}
    </>
  );
}

interface ShellBodyProps {
  command?: string | null;
  active: boolean;
  /** The call standing on the station right now, or null between calls. The
   *  classifier is asked about IT — a station has no language of its own. */
  tool?: { name: string; input: unknown } | null;
}

/** The prompt line typing the running command, plus its full-text disclosure.
 *  The widened expanded station (card 287) affords a longer preview and a
 *  taller scroll window — legible without opening anything.
 *
 *  Card 320: the disclosure used to hold `$ {command}` — one raw blob, no
 *  colour, and no edge between the steps of a chain. 77% of the Bash cards in
 *  the store carry `&&` or `||`, so a five-step command was a paragraph of
 *  shell wrapped by the browser at whatever column the card happened to be. The
 *  tool card one layer up already draws one properly, and the value here is
 *  doing it the SAME way rather than a second way: `breakShellChain` and
 *  `highlight`, the pair ToolViewBody's command region calls. Display only —
 *  the record keeps its own bytes, which is what shellStation.test.tsx holds
 *  the rendered text against.
 *
 *  The LANGUAGE is asked, not asserted. `blockLang` reads a declared `language`
 *  field first and only then the key, so a call that says what it carries is
 *  believed; a station that hardcoded a literal could not do that, and would be
 *  a second answer to a question the tool card already answers. */
function ShellBody({ command, active, tool }: ShellBodyProps) {
  const lang = useLang();
  const expandAll = useContext(ExpandAllContext);
  const previewChars = expandAll ? SHELL_PREVIEW_CHARS_WIDE : SHELL_PREVIEW_CHARS;
  const shown = command
    ? command.length > previewChars
      ? `${command.slice(0, previewChars - 1)}…`
      : command
    : "";
  const hl = tool ? blockLang(tool.name, SHELL_COMMAND_KEY, tool.input) : null;
  return (
    <>
      <div className={`pf-shell${active ? " pf-shell--on" : ""}`}>
        <span className="pf-shell__prompt">$</span>
        {shown ? (
          <span key={shown} className="pf-shell__cmd" style={{ "--n": shown.length } as CSSProperties}>
            {shown}
          </span>
        ) : (
          <span className="pf-shell__idle">{t(lang, "map.gate.none")}</span>
        )}
        <span className="pf-shell__cursor" />
      </div>
      {command && (
        <Disclosure label={t(lang, "map.shell.cmd")}>
          {/* No `$` in here any more: the block is now several lines, and one
              prompt in front of a three-step chain would read as one command. */}
          <div
            className="pf-panelbox pf-mono pf-shell__box nowheel"
            style={{ fontSize: 11, overflow: "auto", maxHeight: expandAll ? 240 : 90 }}
          >
            {highlight(breakShellChain(command), hl)}
          </div>
        </Disclosure>
      )}
    </>
  );
}

/**
 * The MCP call line plus its call disclosure — the same two-faced panel as the
 * agent card's, so the master face governs it too.
 *
 * CARD 328: this is the ASKING half of one exchange, and the `data-call` mark
 * is what lets a reader see that the MCP-Server card across the boundary is
 * answering THIS call and not some other. It used to be fed the in-flight tool
 * slot, which `tool_result` empties — so the question vanished from the map at
 * the exact moment the answer arrived.
 */
function McpBody({
  active,
  mcp,
  call,
}: {
  active: boolean;
  mcp?: string | null;
  call?: { callId: string; name: string; input: unknown } | null;
}) {
  const lang = useLang();
  return (
    <>
      <div className={`pf-os__line${active ? " pf-os__line--on" : ""}`}>
        {mcp ?? t(lang, "map.gate.none")}
      </div>
      {call && (
        <div className="pf-mcp" data-call={call.callId}>
          <Disclosure label={t(lang, "map.mcp.call")}>
            <ToolCallPanel tool={{ name: call.name, input: call.input }} />
          </Disclosure>
        </div>
      )}
    </>
  );
}

/** What the browser station was handed about the last call it recorded. */
export interface BrowserPageView {
  /** The recorded address: a string, a redaction marker, or absent. */
  url?: unknown;
  tool?: string;
  ok?: boolean;
  /** The screenshot blob's HASH, present whenever a picture was taken. */
  sha256?: string;
  /** The blob the card can load, when the run recorded a path for it. */
  shot?: { blobPath: string; sha256: string } | null;
  /** The component's own latch: the blob was named and the store no longer has
   *  it. The map cannot know — only the failed load can. */
  shotBroken?: boolean;
  /** What the tool answered: the accessibility tree, the page text, or the
   *  refusal and the rule that fired. */
  reading?: string | null;
  /** How long that answer really was, so a cut one can say so. */
  readingChars?: number;
}

/** Which of the four things the browser card is showing. */
export type BrowserCardState = "shot" | "shot-missing" | "reading" | "nothing";

/**
 * What the browser card is showing, given what failed to load.
 *
 * Pure, and exported, for two reasons the component cannot serve on its own.
 *
 * A HASH WITH NO PATH is its own state. `browser_action.sha256` says a picture
 * was taken; only an `image_generated` on the same wire says WHERE it lives.
 * Branching on the path alone let a call that took a picture fall through to
 * its reading — or to "neither a picture nor a reading was recorded" — while
 * the record's own doc claimed it said so. It invents no file name either way;
 * that half was always true.
 *
 * A DEAD BLOB IS ONE BLOB. The failed load used to latch a bare boolean that
 * nothing ever reset, and the node id is stable, so React keeps the instance
 * for the session: after one miss every later page with a perfectly good blob
 * rendered "its file is no longer in the store" — a false statement about a
 * picture the card could load. The latch holds the PATH that failed instead,
 * so it can only speak about that one.
 *
 * @param page what the map handed the card
 * @param brokenShot the blob path whose load failed in this browser, or null
 * @return the state the card renders, and marks with `data-page-state`
 */
export function browserPageState(page: BrowserPageView, brokenShot: string | null): BrowserCardState {
  const shot = page.shot ?? null;
  if (shot !== null)
    return shot.blobPath === brokenShot || page.shotBroken === true ? "shot-missing" : "shot";
  if (page.sha256 !== undefined && page.sha256 !== "") return "shot-missing";
  const reading = page.reading ?? null;
  return reading !== null && reading !== "" ? "reading" : "nothing";
}

/**
 * The browser station's body — the page this run RECORDED (card 330).
 *
 * It is a replay, never a browser: nothing here reaches the recorded address,
 * and the only request the card can make is to the image endpoint for a blob
 * the run itself stored. There is no HTML on the wire and there never was —
 * `browser_action` is metadata only, by design — so what the card can show is
 * the picture that was taken, or the reading that was recorded, or the honest
 * sentence that neither happened. Those are four different facts and none of
 * them is drawn as another.
 */
function BrowserBody({ page }: { page?: BrowserPageView | null }) {
  const lang = useLang();
  // COMPACT is a glance, and the band it stands in is what says so: the `z-os`
  // frame leaves 156px between a station's seat and its floor, and this card
  // rendering a page at all measured 202.44 there (Chrome, dPR 2, both fonts
  // loaded, real markup — see COMPACT_BROWSER_H in sceneToFlow). A card that
  // does not fit its frame draws THROUGH it, and the only ways to fit a page
  // into 156px are to cut the reading silently or to shrink the picture to a
  // strip. So compact names the state and expanded shows the artefact — which
  // is what the two neighbouring stations already do: the MCP client keeps its
  // call behind a closed disclosure and the shell clips its command.
  const expandAll = useContext(ExpandAllContext);
  // The PATH that failed to load, not a bare "something failed": of six
  // image_generated events on this machine five blobs exist and one does not,
  // so a run that mixes the two is the expected case and a boolean latch would
  // have called every later picture missing.
  const [brokenShot, setBrokenShot] = useState<string | null>(null);
  if (page === undefined || page === null) {
    return <div className="pf-os__line">{t(lang, "map.browser.none")}</div>;
  }
  const urlState = recordedUrlState(page.url);
  const pageState = browserPageState(page, brokenShot);
  const shotSrc = pageState === "shot" && page.shot != null ? screenshotUrl(page.shot) : null;
  const reading = page.reading ?? null;
  const cut = (page.readingChars ?? 0) - (reading?.length ?? 0);
  const rule = urlState === "redacted" ? redactionRule(page.url) : "";
  const failed = page.ok === false;
  return (
    <div className="pf-browser" data-url-state={urlState} data-page-state={pageState}>
      {page.tool !== undefined && (
        // WHICH verb, and whether it worked. 3 of the 4 real browser_action
        // events on this machine are `ok: false`, and with this row absent a
        // refusal and a success rendered alike — the only thing that gave a
        // refusal away was whatever prose the tool happened to answer.
        <div
          className={`pf-browser__verb${failed ? " pf-browser__verb--failed" : ""}`}
          data-ok={String(!failed)}
        >
          <span className="pf-browser__tool">{page.tool}</span>
          {failed && <span className="pf-browser__failed">{t(lang, "map.browser.failed")}</span>}
        </div>
      )}
      <div className="pf-browser__url" title={urlState === "address" ? String(page.url) : undefined}>
        {urlState === "address"
          ? String(page.url)
          : urlState === "redacted"
            ? `${t(lang, "map.net.redacted")}${rule === "" ? "" : ` · ${rule}`}`
            : t(lang, "map.browser.noPage")}
      </div>
      {!expandAll && (
        // One line, and it is a STATE and not a summary of the artefact: the
        // glance says which of the four things happened, the expanded card
        // shows it.
        <div className="pf-browser__glance">{t(lang, `map.browser.at.${pageState}`)}</div>
      )}
      {expandAll && pageState === "shot" && shotSrc !== null && (
        <img
          className="pf-browser__shot"
          src={shotSrc}
          alt={t(lang, "map.browser.shotAlt")}
          onError={() => setBrokenShot(page.shot?.blobPath ?? null)}
        />
      )}
      {expandAll && pageState === "shot-missing" && (
        <div className="pf-browser__gone">{t(lang, "map.browser.shotGone")}</div>
      )}
      {expandAll && pageState === "reading" && (
        <>
          <div className="pf-browser__read pf-mono nowheel">{reading}</div>
          {cut > 0 && (
            // The cut is said, never hidden — the same device the MCP answer
            // beside it uses. Without it a page cut mid-token read as the whole
            // recording, and the record carried no length to say otherwise.
            <div
              className="pf-browser__cut"
              title={t(lang, "map.browser.cut", { shown: reading?.length ?? 0, all: page.readingChars ?? 0 })}
            >
              {t(lang, "map.mcp.more", { n: cut })}
            </div>
          )}
        </>
      )}
      {expandAll && pageState === "nothing" && (
        <div className="pf-browser__gone">{t(lang, "map.browser.nothing")}</div>
      )}
    </div>
  );
}

export function OsNode({ data }: NodeProps) {
  const d = data as {
    kind: "disk" | "shell" | "net" | "mcp" | "browser";
    active: boolean;
    disk?: "idle" | "read" | "write";
    file?: string | null;
    command?: string | null;
    mcp?: string | null;
    /** CARD 320: the call standing on the shell station right now, or null
     *  between calls — the classifier is asked about IT, because a station has
     *  no language of its own. Card 328 rewrote this whole declaration to add
     *  `call` and `page` and dropped this line on the way; the merge took that
     *  side, sceneToFlow.ts kept feeding the field, and only tsc noticed. */
    tool?: { name: string; input: unknown } | null;
    /** CARD 328: the MCP exchange this card is the asking half of. */
    call?: { callId: string; name: string; input: unknown } | null;
    /** CARD 330: the last browser call this run recorded. */
    page?: BrowserPageView | null;
    /** Who is on the station right now — first entry is the occupant whose
     *  content shows, the rest are "also" (stationUsers, owner call 2026-08-26).
     *  Each carries its agentId since card 295, so a caller can address the
     *  occupant's own rail. */
    by?: { tag: string; name: string; agentId: string }[];
    /** The tag of that first occupant — "main" or a worker's "wN". The card and
     *  its rail wear the worker accent when a worker holds the station. */
    byTag?: string | null;
  };
  const lang = useLang();
  const expandAll = useContext(ExpandAllContext);

  let station: { title: string; body: ReactNode };
  switch (d.kind) {
    case "disk":
      station = { title: "Disk", body: <DiskBody disk={d.disk} file={d.file} /> };
      break;
    case "shell":
      station = {
        title: "Shell",
        body: <ShellBody command={d.command} active={d.active} tool={d.tool} />,
      };
      break;
    case "net":
      station = { title: t(lang, "map.node.network"), body: <NetGlobe active={d.active} /> };
      break;
    case "mcp":
      station = { title: "MCP-Client", body: <McpBody active={d.active} mcp={d.mcp} call={d.call} /> };
      break;
    case "browser":
      station = { title: t(lang, "map.node.browser"), body: <BrowserBody page={d.page} /> };
      break;
  }

  return (
    // Expanded, the stations paint at the widths their SEATS reserve
    // (EXPANDED_CARD / stationSeats) — the compact widths in the stylesheet
    // would leave the reserved room empty and the command clipped anyway.
    <div
      className={
        `pf-card pf-os pf-os--${d.kind}` +
        `${expandAll ? " pf-os--wide" : ""}` +
        `${d.active ? " pf-card--active pf-os--busy" : ""}` +
        `${d.active && d.byTag !== undefined && d.byTag !== null && d.byTag !== "main" ? " pf-os--worker" : ""}`
      }
    >
      <div className="pf-os__head">
        <span className="pf-eyebrow">{station.title}</span>
      </div>
      {d.by !== undefined && d.by.length > 0 && (
        // The station shows ONE occupant's content — the fold's first match,
        // main before the workers. The others are not dropped: each is named
        // here, because a worker that is silently demoted looks like a worker
        // that is doing nothing (card 295).
        <div
          className="pf-os__by"
          title={
            d.by.length > 1
              ? `${t(lang, "map.station.shared")}: ${d.by
                  .map((u) => (u.tag === "main" ? "main" : `${u.tag} · ${u.name}`))
                  .join(", ")}`
              : undefined
          }
        >
          <span className="pf-os__by-user" title={d.by[0].name}>
            {d.by[0].tag === "main" ? "main" : `${d.by[0].tag} · ${d.by[0].name}`}
          </span>
          {d.by.length > 1 && (
            // The extras wrap onto their own lines. The compact station card is
            // ~152px wide, so a second name on the SAME line clipped both of
            // them to nothing — measured in the browser, not guessed. Two named
            // extras at most, then a count, so a station shared by six workers
            // cannot grow the card without bound; the full list is in the title.
            <span className="pf-os__by-also">
              {t(lang, "map.station.also")}
              {d.by.slice(1, 3).map((u) => (
                <span key={u.tag} className="pf-os__by-extra" title={u.name}>
                  {u.tag} · {u.name}
                </span>
              ))}
              {d.by.length > 3 && <span className="pf-os__by-more">+{d.by.length - 3}</span>}
            </span>
          )}
        </div>
      )}
      {station.body}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------
export function LlmNode({ data }: NodeProps) {
  const d = data as {
    active: boolean;
    provider: string;
    model: string;
    think: AgentStream[];
    answer: AgentStream[];
  };
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
      <div className="pf-llm__net">
        <NeuralNet active={d.active} />
      </div>
      <div className="pf-llm__name">LLM</div>
      <div className="pf-llm__model">{d.model || d.provider}</div>
      <div className="pf-llm__loc">
        <b>{t(lang, "map.remote")}</b> · {d.provider}
      </div>
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
/**
 * The answer half of one MCP exchange (card 328).
 *
 * An error is an answer and is drawn as one — a mark and the server's own
 * words, never a crash — because that is what the reader has to be able to
 * read: a `mcp__` result that failed carries at most 911 bytes (measured over
 * 191 of them) and saying WHAT the server refused is the whole value.
 */
/**
 * How long the server took, as a reading.
 *
 * `formatDuration` is the app's own and is used in ten places, but its
 * contract stops at a tenth of a second — "412 -> 0.4 s" — and this card's
 * MEASURED median is 23 ms, which it renders as "0.0 s": a zero printed for
 * something that took time. So milliseconds stand where milliseconds are the
 * truth, and the shared formatter takes over the moment there is a second to
 * round. It replaces a raw `3598164 ms` at the top end, which is the measured
 * max and was unreadable.
 *
 * @param ms the answer's own durationMs, off the wire
 * @return the reading
 */
function answerTook(ms: number): string {
  return ms < 1000 ? `${ms} ms` : formatDuration(ms);
}

function McpAnswerBody({ a }: { a: McpAnswerView }) {
  const lang = useLang();
  // The two GATE readings come first, and they are about this machine rather
  // than the server. Both used to render as something the server was doing: a
  // pending gate as "waiting for the answer …", and a refusal as an error
  // answer carrying "ERROR: the user denied the execution." — which is the
  // harness's own sentence, at 200 ms, for a packet that never left.
  if (a.state === "gated") {
    return <div className="pf-mcpa pf-mcpa--gate">{t(lang, "map.mcp.gated")}</div>;
  }
  if (a.state === "denied") {
    return <div className="pf-mcpa pf-mcpa--gate pf-mcpa--refused">{t(lang, "map.mcp.denied")}</div>;
  }
  if (a.state === "waiting") {
    // A call can stay here for an hour — measured max 3 598 164 ms over 503
    // pairs, and 3 of 783 sessions never answer at all. Nothing decays it.
    return <div className="pf-mcpa pf-mcpa--waiting">{t(lang, "map.mcp.waiting")}</div>;
  }
  if (a.state === "empty") return <div className="pf-mcpa pf-mcpa--empty">{t(lang, "map.mcp.empty")}</div>;
  const cut = a.chars - a.text.length;
  return (
    <div className={`pf-mcpa${a.isError ? " pf-mcpa--err" : ""}`}>
      <div className="pf-mcpa__meta">
        {t(lang, a.isError ? "map.mcp.errored" : "map.mcp.answered")} · {answerTook(a.durationMs)}
      </div>
      <div className="pf-mcpa__body pf-mono nowheel">{a.text}</div>
      {cut > 0 && (
        // The cut is said, never hidden. The chip is what fits on a 150px card;
        // its title carries the sentence, including where the whole answer is —
        // the tool_result row in the JSONL trace, which holds it uncut.
        <div className="pf-mcpa__cut" title={t(lang, "map.mcp.cut", { shown: a.text.length, all: a.chars })}>
          {t(lang, "map.mcp.more", { n: cut })}
        </div>
      )}
    </div>
  );
}

export function ExtNode({ data }: NodeProps) {
  const d = data as {
    kind: "netz" | "mcpserver";
    active: boolean;
    mcp?: string | null;
    /** CARD 328: the answering half of the exchange the MCP client is asking. */
    answer?: McpAnswerView | null;
    /** CARD 329: what this run put across the network boundary. */
    net?: NetCardView | null;
  };
  const lang = useLang();
  if (d.kind === "netz") {
    const net = d.net ?? { hosts: [], more: 0, redacted: false, crossed: false };
    return (
      <div
        className={`pf-card pf-ext pf-ext--center${d.active ? " pf-card--active" : ""}`}
        // The mark that makes the empty state checkable — and the empty state
        // is the COMMON one: 36 of 783 sessions reached anything at all.
        data-reached={net.crossed ? "reached" : "none"}
      >
        <div className="pf-ext__head">{t(lang, "map.node.netz")}</div>
        <Router active={d.active} />
        {net.crossed ? (
          <div className="pf-net">
            {net.redacted && (
              // Never a host. The record says an address was there and
              // deliberately does not say which — a different fact from both
              // "reached this host" and "reached nothing".
              <div className="pf-net__row pf-net__row--redacted" data-host-state="redacted">
                {t(lang, "map.net.redacted")}
              </div>
            )}
            {net.hosts.map((h) => (
              // The host as recorded, NOT filed under a category. 58 of the 137
              // exchanges on this machine went to a tailnet address that is
              // neither loopback nor the public internet, and which shape ships
              // is an owner call — so the card prints what it has.
              //
              // And nothing beside it. This row carried a per-host `{n}x`, and
              // the number was not a count of hops: every browser tool call
              // records the page the browser ENDED on, so five read-only verbs
              // on one open page counted five.
              <div key={h} className="pf-net__row" data-host={h} title={h}>
                <span className="pf-net__host">{h}</span>
              </div>
            ))}
            {net.more > 0 && (
              <div className="pf-net__more" data-hosts-more={String(net.more)}>
                {t(lang, "map.more", { n: net.more })}
              </div>
            )}
          </div>
        ) : (
          <div className="pf-net__none">{t(lang, "map.net.nothing")}</div>
        )}
        <Handles />
      </div>
    );
  }
  const a = d.answer ?? null;
  return (
    <div
      className={`pf-card pf-ext pf-ext--center${d.active ? " pf-card--active" : ""}`}
      // The two marks that make this card checkable rather than decorative:
      // WHICH call it is answering, and WHICH of the four things it is saying.
      data-answer={a === null ? "none" : a.state}
      {...(a === null ? {} : { "data-call": a.callId })}
      {...(a !== null && a.isError ? { "data-answer-error": "true" } : {})}
    >
      <div className="pf-ext__head">{t(lang, "map.node.mcpServer")}</div>
      <AluChip active={d.active} />
      <div className={`pf-ext__sub${d.active ? " pf-ext__sub--on" : ""}`}>
        {d.mcp ?? t(lang, "map.extServer")}
      </div>
      {a !== null && <McpAnswerBody a={a} />}
      <Handles />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subagent loop
// ---------------------------------------------------------------------------
/** The worker's slice of the agent-card data shape — everything the child's
 *  own fold carries; the context columns stay null (a child's context parts
 *  are not on this wire) and the brief stands in for the prompt. */
function workerAgentData(d: { active: boolean; focus: Focus; activity: Activity; full: SubFull }): AgentData {
  return {
    active: d.active,
    error: d.full.error,
    focus: d.focus,
    activity: d.activity,
    gate: d.full.gate,
    gateNote: d.full.gateNote,
    gateColor: d.full.gateColor,
    activeTool: d.full.activeTool,
    ctxParts: null,
    ctxTotals: null,
    prompt: d.full.brief ?? "",
    systemPrompt: null,
    tool: d.full.tool,
    genImage: d.full.genImage,
    attached: d.full.attached,
  };
}

type SubFull = {
  error: boolean;
  gate: GateState;
  gateNote: string;
  gateColor: string;
  activeTool: string | null;
  tool: { name: string; input: unknown } | null;
  genImage: { src: string; prompt: string } | null;
  attached: { src: string; note: string }[] | null;
  brief: string | null;
  model: string | null;
  spend: { peak: number; turns: number } | null;
};

export function SubagentNode({ data }: NodeProps) {
  const lang = useLang();
  const d = data as {
    id: string;
    label: string | null;
    task: string;
    state: SubagentInfo["state"];
    stateLabel: string;
    stateColor: string;
    lastStatus: string | null;
    activity: Activity;
    focus: Focus;
    active: boolean;
    think: string;
    /** Present only in the expanded view: the worker renders as the agent's
     *  own card with this data (card 287). Absent = compact, byte-identical
     *  to what shipped. */
    full?: SubFull;
    /** CARD 306: true for a member card a workflow box seated, absent for a
     *  loose one. It puts `.pf-sub--boxed` on the compact card, and that class
     *  is what the caps in flowmap.css hang off — the caps that make the
     *  band's reserve a bound rather than an observation about the thirteen
     *  cards somebody happened to measure. */
    boxed?: boolean;
  };
  if (d.full !== undefined) {
    // The opaque agent id lives ONLY in the title attribute — the visible
    // name is the task the spawner phrased, then the kind label, then nothing.
    //
    // That name gets its OWN title (card 296 re-review). Card 296 capped this
    // head at two lines to make the worker seat a bound, and the head's title
    // carries the agent id, not the task — so a long task title was clipped
    // with nowhere left to read it. The cap earns its place (measured: paying
    // the 15 world px back moves the reserve to 495, and at 495 three seats
    // fall back to two rows and twelve to three, which is the complaint card
    // 296 exists to fix), so the text is made recoverable instead.
    const name = d.task || d.label || "worker";
    return (
      <div className={`pf-card pf-sub pf-sub--full${d.active ? " pf-card--active" : ""}`}>
        <div className="pf-sub__head" title={d.id}>
          <span className="pf-sub__id" title={name}>
            <span className="pf-sub__dot" style={{ background: d.stateColor }} />
            {name}
          </span>
          {d.label !== null && <span className="pf-badge">{d.label}</span>}
          <span className="pf-badge" style={{ color: d.stateColor }}>
            {d.stateLabel}
          </span>
        </div>
        <AgentCardBody
          scrollShelf
          // CARD 319 budgets the HUB. This card's height is a measured bound
          // that the whole worker grid is seated from (cardGeometry.ts), so
          // the hub's reserves would move every seat on the map.
          budget={false}
          data={workerAgentData({ active: d.active, focus: d.focus, activity: d.activity, full: d.full })}
        />
        <div className="pf-sub__meta nowheel nodrag">
          {d.full.brief !== null && (
            <Disclosure label={t(lang, "map.sub.brief")}>
              <div className="pf-prose nowheel" style={{ textAlign: "left" }}>
                {d.full.brief}
              </div>
            </Disclosure>
          )}
          {d.full.spend !== null && (
            <span className="pf-kv">
              {t(lang, "map.sub.peak")}{" "}
              <b className="tabular">{d.full.spend.peak.toLocaleString(lang === "de" ? "de-DE" : "en-US")}</b>{" "}
              tok · {d.full.spend.turns}{" "}
              {t(lang, d.full.spend.turns === 1 ? "map.sub.turn" : "map.sub.turns")}
            </span>
          )}
          {d.full.model !== null && <span className="pf-kv">{d.full.model}</span>}
          {d.lastStatus !== null && (
            <span className="pf-kv">
              {t(lang, "map.sub.lastStatus")} <b>{d.lastStatus}</b>
            </span>
          )}
        </div>
        <Handles />
      </div>
    );
  }
  return (
    <div
      className={`pf-card pf-sub${d.boxed === true ? " pf-sub--boxed" : ""}${
        d.active ? " pf-card--active" : ""
      }`}
    >
      <div className="pf-sub__head">
        <span className="pf-sub__id">
          <span className="pf-sub__dot" style={{ background: d.stateColor }} />
          {d.label ? `${d.label} · ${d.id}` : d.id}
        </span>
        <span className="pf-badge" style={{ color: d.stateColor }}>
          {d.stateLabel}
        </span>
      </div>
      <div className="pf-sub__task">{d.task}</div>
      <div className="pf-sub__status" style={{ color: d.activity.color }}>
        <span className={`pf-status__dot${d.focus === "llm" ? " pf-pulse" : ""}`} />
        {d.activity.text}
      </div>
      {d.boxed !== true && (d.lastStatus || d.think) && (
        // CARD 306: a boxed member is drawn WITHOUT this control, and that is
        // the only thing that holds its band.
        //
        // Its band reserves a shut card. An open body renders about 95px past
        // that, and React Flow does not put it back: measured in Chrome, its
        // `extent: "parent"` clamps a child's POSITION and never its SIZE, and
        // it clamps to the BOX rather than to the band — so a member in the
        // first band that grows simply stands on the row below it, and in the
        // last band the clamp fires and walks the card up onto the row above.
        // Capping the card instead (flowmap.css) leaves the button drawing a
        // body nobody can see. A control whose every outcome is damage or a
        // clipped nothing is worse than no control, so the detail lives one
        // click away on the box's own switch, which redraws every member as
        // the full instrument.
        <Disclosure label={t(lang, "map.sub.disc")}>
          <div className="pf-panelbox">
            <div className="pf-panelbox__label">{t(lang, "map.sub.order")}</div>
            <div className="pf-prose nowheel">{d.task}</div>
          </div>
          {d.lastStatus && (
            <div className="pf-kv">
              {t(lang, "map.sub.lastStatus")} <b>{d.lastStatus}</b>
            </div>
          )}
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
  // Card 306's box lives in its own module for the reason card 293's node
  // does: React Flow takes it through this map and never through JSX, which
  // the component-reach drift gate cannot tell from an orphan while the two
  // share a file. Imported, the import IS the attachment.
  wfbox: WorkflowBoxNode,
  user: UserNode,
  agent: AgentNode,
  os: OsNode,
  llm: LlmNode,
  ext: ExtNode,
  subagent: SubagentNode,
};

// The "System-Kontext" tab: what goes to the LLM BEFORE any user message. It
// fetches GET /api/context (the MAIN agent's assembled system prompt, tools,
// skills, MCP servers + the subagent role profiles) and shows the context of the
// agent SELECTED in the Agenten tab: main -> the full server context; a subagent
// -> its role prompt (composed with its actual task) + tool profile.
//
// The endpoint is stateless (boot config), so a live provider/model/thinking
// switch is overlaid from props — no refetch needed. A "Raw" button opens the
// FULL prompt in a fullscreen modal (nothing truncated).

import { useEffect, useState } from "react";
import type { AgentInfo } from "../state/reducer";
import { Markdown } from "./Markdown";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

interface ToolInfo { name: string; description: string; needsPermission: boolean }
interface SkillInfo { name: string; description: string }
interface RoleProfile {
  type: string; kind: string; systemPrompt: string; tools: string[]; readOnly: boolean; skill: string | null;
}
interface ContextInfo {
  systemPrompt: string;
  tools: ToolInfo[];
  skills: SkillInfo[];
  mcpServers: string[];
  thinking: boolean;
  provider: string;
  model: string;
  subagentProfiles: RoleProfile[];
}

/** Map a roster agent to its role profile: dev tools carry a label (build_plan …);
 *  plain spawns are identified by the id prefix (explore-1 -> explore). */
function profileFor(agent: AgentInfo, profiles: RoleProfile[]): RoleProfile | undefined {
  if (agent.label !== null) {
    const byLabel = profiles.find((p) => p.type === agent.label);
    if (byLabel) return byLabel;
  }
  const prefix = agent.id.split("-")[0];
  return profiles.find((p) => p.type === prefix);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ctx-section">
      <h4 className="ctx-section-title">{title}</h4>
      {children}
    </section>
  );
}

/** Raw = the WHOLE context as plain text — the prompt AND everything below it
 *  (model, tools, skills, MCP, roles), nothing prettified. Pure serializer:
 *  main gets the full server context, a subagent its role prompt + task +
 *  tool profile; the overlay carries any live provider/model/thinking switch. */
function buildRawContextText(
  ctx: ContextInfo,
  selected: AgentInfo | null,
  profile: RoleProfile | undefined,
  overlay: { provider: string; model: string; thinking: boolean },
  lang: Lang,
): string {
  const isMain = selected === null || selected.parentId === null;
  const rule = (label: string): string => `\n\n──────── ${label} ────────\n`;
  if (isMain) {
    return ctx.systemPrompt +
      rule(t(lang, "ctx.rule.model")) +
      `Provider: ${overlay.provider}\nModel:    ${overlay.model}\nThinking: ${overlay.thinking ? t(lang, "ctx.on") : t(lang, "ctx.off")}` +
      rule(`TOOLS (${ctx.tools.length})`) +
      ctx.tools.map((tl) => `${tl.name}${tl.needsPermission ? " [gate]" : ""} — ${tl.description}`).join("\n") +
      rule(`SKILLS (${ctx.skills.length})`) +
      (ctx.skills.length === 0 ? t(lang, "ctx.none") : ctx.skills.map((s) => `${s.name} — ${s.description}`).join("\n")) +
      rule(`MCP-SERVER (${ctx.mcpServers.length})`) +
      (ctx.mcpServers.length === 0 ? t(lang, "ctx.noneConfigured") : ctx.mcpServers.join("\n")) +
      rule(`${t(lang, "ctx.rule.roles")} (${ctx.subagentProfiles.length})`) +
      ctx.subagentProfiles
        .map((p) => `${p.type} (${p.kind === "dev" ? "dev" : "spawn"}${p.readOnly ? ", read-only" : ""}${p.skill !== null ? `, skill: ${p.skill}` : ""})`)
        .join("\n");
  }
  return profile
    ? profile.systemPrompt +
      (selected!.task ? rule(t(lang, "ctx.rule.task")) + selected!.task : "") +
      rule(`TOOLS (${profile.tools.length})`) +
      profile.tools.join("\n")
    : t(lang, "ctx.noProfileRaw");
}

export function SystemContextTab({
  selected,
  provider,
  model,
  thinking,
}: {
  selected: AgentInfo | null;
  provider?: string;
  model?: string;
  thinking: boolean;
}) {
  const lang = useLang();
  const [ctx, setCtx] = useState<ContextInfo | null>(null);
  const [error, setError] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(false);
    fetch("/api/context")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c) => { if (alive) setCtx(c as ContextInfo); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  // The raw view closes on Escape and whenever the selected agent changes.
  useEffect(() => {
    if (!rawOpen) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setRawOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rawOpen]);
  useEffect(() => setRawOpen(false), [selected]);

  if (error) return <p className="ctx-empty">{t(lang, "ctx.unavailable")}</p>;
  if (ctx === null) return <p className="ctx-empty">{t(lang, "ws.loading")}</p>;

  const isMain = selected === null || selected.parentId === null;

  // Provider/model/thinking are overlaid from the live session (a switch wins).
  const shownProvider = provider ?? ctx.provider ?? "—";
  const shownModel = model ?? ctx.model ?? "—";

  const profile = isMain ? undefined : profileFor(selected!, ctx.subagentProfiles);
  const rawTitle = `${t(lang, "rp.context")} · ${isMain ? "main" : selected!.id}`;
  const rawText = buildRawContextText(ctx, selected, profile,
    { provider: shownProvider, model: shownModel, thinking }, lang);

  return (
    <div className="ctx">
      <div className="ctx-head">
        <p className="ctx-lead">
          {lang === "de" ? (
            <>Das geht ans <span className="mono">LLM</span> <em>bevor</em> du etwas schickst —{" "}</>
          ) : (
            <>This goes to the <span className="mono">LLM</span> <em>before</em> you send anything —{" "}</>
          )}
          {isMain ? t(lang, "ctx.leadMain") : t(lang, "ctx.leadSub", { id: selected?.id ?? "" })}
        </p>
        <button type="button" className="ctx-raw-btn" onClick={() => setRawOpen(true)} title={t(lang, "ctx.rawTitle")}>
          Raw
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2H2v4M10 14h4v-4M2 2l5 5M14 14l-5-5" />
          </svg>
        </button>
      </div>

      {isMain ? (
        <>
          <Section title={t(lang, "map.ctx.systemPrompt")}>
            {/* Keeps its own box, but rendered as markdown (Raw shows the plain text). */}
            <div className="ctx-pre ctx-prompt-md">
              <Markdown text={ctx.systemPrompt} />
            </div>
          </Section>

          <Section title={t(lang, "ctx.model")}>
            <dl className="ctx-kv">
              <div><dt>Provider</dt><dd className="mono">{shownProvider}</dd></div>
              <div><dt>{t(lang, "ctx.model")}</dt><dd className="mono">{shownModel}</dd></div>
              <div><dt>Thinking</dt><dd>{thinking ? t(lang, "ctx.on") : t(lang, "ctx.off")}</dd></div>
            </dl>
          </Section>

          <Section title={`Tools (${ctx.tools.length})`}>
            <ul className="ctx-tools">
              {ctx.tools.map((tl) => (
                <li key={tl.name}>
                  <span className="ctx-tool-name mono">{tl.name}</span>
                  {tl.needsPermission && <span className="ctx-perm" title={t(lang, "ctx.gateTitle")}>gate</span>}
                  <span className="ctx-tool-desc">{tl.description}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title={`Skills (${ctx.skills.length})`}>
            {ctx.skills.length === 0 ? (
              <p className="ctx-none">{t(lang, "ctx.none")}</p>
            ) : (
              <ul className="ctx-skills">
                {ctx.skills.map((s) => (
                  <li key={s.name}>
                    <span className="ctx-tool-name mono">{s.name}</span>
                    <span className="ctx-tool-desc">{s.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`MCP-Server (${ctx.mcpServers.length})`}>
            {ctx.mcpServers.length === 0 ? (
              <p className="ctx-none">{t(lang, "ctx.noneConfigured")}</p>
            ) : (
              <ul className="ctx-mcp">
                {ctx.mcpServers.map((m) => <li key={m} className="mono">{m}</li>)}
              </ul>
            )}
            <p className="ctx-note">{t(lang, "ctx.mcpNote")}</p>
          </Section>

          <Section title={`${t(lang, "ctx.roles")} (${ctx.subagentProfiles.length})`}>
            <p className="ctx-note">{t(lang, "ctx.rolesNote")}</p>
            <ul className="ctx-roles">
              {ctx.subagentProfiles.map((p) => (
                <li key={p.type}>
                  <span className="ctx-tool-name mono">{p.type}</span>
                  <span className="ctx-role-tag">{p.kind === "dev" ? "dev" : "spawn"}</span>
                  {p.readOnly && <span className="ctx-role-tag ctx-role-tag--ro">read-only</span>}
                  {p.skill !== null && <span className="ctx-tool-desc">skill: {p.skill}</span>}
                </li>
              ))}
            </ul>
          </Section>
        </>
      ) : (
        <SubagentContext agent={selected!} profile={profile} lang={lang} />
      )}

      {rawOpen && <RawModal title={rawTitle} text={rawText} onClose={() => setRawOpen(false)} />}
    </div>
  );
}

function SubagentContext({ agent, profile, lang }: { agent: AgentInfo; profile: RoleProfile | undefined; lang: Lang }) {
  if (profile === undefined) {
    return <p className="ctx-empty">{t(lang, "ctx.noProfile", { id: agent.id })}</p>;
  }
  return (
    <>
      <Section title={t(lang, "ctx.role")}>
        <dl className="ctx-kv">
          <div><dt>{t(lang, "ctx.type")}</dt><dd className="mono">{profile.type}</dd></div>
          <div><dt>{t(lang, "ctx.kind")}</dt><dd>{profile.kind === "dev" ? t(lang, "ctx.kindDev") : t(lang, "ctx.kindSpawn")}</dd></div>
          <div><dt>{t(lang, "ctx.access")}</dt><dd>{profile.readOnly ? t(lang, "ctx.readOnly") : t(lang, "ctx.full")}</dd></div>
          {profile.skill !== null && <div><dt>Skill</dt><dd className="mono">{profile.skill}</dd></div>}
        </dl>
      </Section>

      <Section title={t(lang, "ctx.promptRole")}>
        <div className="ctx-pre ctx-prompt-md">
          <Markdown text={profile.systemPrompt} />
        </div>
      </Section>

      {agent.task !== "" && (
        <Section title={t(lang, "ctx.taskSeen")}>
          <pre className="ctx-pre">{agent.task}</pre>
        </Section>
      )}

      <Section title={`Tools (${profile.tools.length})`}>
        <ul className="ctx-mcp">
          {profile.tools.map((tl) => <li key={tl} className="mono">{tl}</li>)}
        </ul>
        <p className="ctx-note">{t(lang, "ctx.noNesting")}</p>
      </Section>
    </>
  );
}

/** The full prompt over the whole screen — nothing truncated. Backdrop / Escape
 *  close it; a copy button grabs the entire text. */
function RawModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const lang = useLang();
  const copy = (): void => {
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
      () => {},
    );
  };
  return (
    <div className="raw-modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="raw-modal" onClick={(e) => e.stopPropagation()}>
        <div className="raw-modal-head">
          <span className="raw-modal-title">{title}</span>
          <span className="raw-modal-meta mono tabular">{t(lang, "ctx.chars", { n: text.length })}</span>
          <button type="button" className="raw-modal-copy" onClick={copy}>{copied ? t(lang, "ctx.copied") : t(lang, "ctx.copy")}</button>
          <button type="button" className="icon-button raw-modal-close" aria-label={t(lang, "common.close")} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <pre className="raw-modal-pre">{text}</pre>
      </div>
    </div>
  );
}

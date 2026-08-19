// What the sidebar's session list needs before it can draw a row: the glyph a
// session earns. A pure fold over the list the sidebar already fetched — no
// React, no second request. A per-row lookup is out of the question here: the
// list is refetched on every finished run and can hold hundreds of rows.
//
// The fold and the glyph that draws it live in one file, like FleetSigil:
// three channels encoded in one place cannot drift from three channels decoded
// in another.
//
// The SECOND fold this file carried — grouping look-alike rows into a pile —
// is gone (owner, 2026-08-12). The list is flat. The pile was a workaround for
// 229 files from one smoke test that still fires, and that mess belongs
// upstream, not behind a chevron.

import type { SessionMeta } from "../events";
import { CLEAN_FINISHES } from "../state/stopReason";
import { t, type Lang } from "../i18n/i18n";
import { formatDuration } from "../format";

/** One hairline of a session's comb — the brand mark applied to a run. */
export interface SignalBar {
  /** Design token for the fill; never a literal colour. */
  token: string;
  /** SVG units. The main agent is the strong line, subagents are satellites. */
  width: number;
}

/** How the last main run finished, as far as the recorded stop reason says. */
export type SessionOutcome = "clean" | "cut" | "failed" | "open";

/** Whether the run met the permission gate, and how hard. */
export type SessionGate = "none" | "asked" | "denied";

export interface SessionSignal {
  bars: SignalBar[];
  /** Agents beyond the drawn comb — five hairlines is where a comb stops
   *  reading as a count and starts reading as a smudge. */
  more: number;
  outcome: SessionOutcome;
  gate: SessionGate;
}

/** Widest comb before the bars stop being countable at sidebar size. */
const MAX_BARS = 5;

/** The main agent rides the hero line; the satellites cycle the agent accents,
 *  the same vocabulary the chat and the fleet sigil already use. */
const BAR_TOKENS = ["var(--agent-root)", "var(--agent-explore)", "var(--agent-worker)", "var(--agent-extra)"];

/**
 * The glyph a session earns. Three independent channels, each from one
 * recorded fact: the comb counts who ran, the gate mark says whether anything
 * had to ask, and the outcome says how it ended.
 */
export function sessionSignal(meta: SessionMeta): SessionSignal {
  const agents = Math.max(1, meta.agentCount ?? 1);
  const drawn = Math.min(agents, MAX_BARS);
  const bars: SignalBar[] = [];
  for (let i = 0; i < drawn; i++) {
    bars.push({ token: BAR_TOKENS[i % BAR_TOKENS.length], width: i === 0 ? 2.6 : 1.3 });
  }
  return {
    bars,
    more: agents - drawn,
    outcome: outcomeOf(meta.stopReason),
    gate: gateOf(meta),
  };
}

/**
 * The recorded stop reason, read as a finish.
 *
 * <p>Only "end_turn" is a plain finish. Anything else this edition does not
 * know by name is read as a cut rather than as clean: a stop reason we cannot
 * interpret is still evidence that the run did not simply run out of things to
 * say, and the quieter mistake is to mark a clean run as interesting.</p>
 */
function outcomeOf(stopReason: string | null | undefined): SessionOutcome {
  if (stopReason === null || stopReason === undefined || stopReason === "") return "open";
  // Card 282: read from the SHARED set rather than from a literal here. This
  // line used to name end_turn alone, which was right until card 267 added
  // goal_met — a run that met its goal is the cleanest finish there is, and it
  // was drawing the cut dot. The transcript and this row now answer the
  // question from one definition and cannot drift apart again.
  if (CLEAN_FINISHES.has(stopReason)) return "clean";
  if (stopReason === "error") return "failed";
  return "cut";
}

function gateOf(meta: SessionMeta): SessionGate {
  if ((meta.denyCount ?? 0) > 0) return "denied";
  if ((meta.gateCount ?? 0) > 0) return "asked";
  return "none";
}

/**
 * What ran this session, in one label. The model is the answer anyone actually
 * wants; the provider is the fallback for files recorded before the model was
 * on the wire. The store writes "-" when it has no provider either, and that
 * dash is a placeholder, not a name — it renders as nothing.
 */
export function sessionModelLabel(meta: SessionMeta): string {
  if (meta.model !== undefined && meta.model !== null && meta.model !== "") return meta.model;
  const provider = meta.provider ?? "";
  return provider === "-" ? "" : provider;
}

/** The counted things a row and its hover name. */
export type CountKind = "agent" | "turn" | "token";

/**
 * "1 turn", "11 turns" — a counted label that does not read as a template
 * someone forgot to finish.
 *
 * <p>The plural comes from {@code n} and the text from {@code display},
 * because the row abbreviates large token counts: "34.0k" carries no number a
 * plural rule can be read off, and "34.0k token" is exactly the kind of small
 * wrongness that makes a careful interface look careless. German agrees with
 * English on the two cases that matter here — one is singular, zero is
 * plural — so one rule serves both.</p>
 *
 * @param lang    the chrome language
 * @param kind    which noun
 * @param n       the real count, which decides singular or plural
 * @param display what to print instead of the count, when it is abbreviated
 */
export function countLabel(lang: Lang, kind: CountKind, n: number, display: string | number = n): string {
  return t(lang, `sess.${kind}${n === 1 ? "" : "s"}`, { n: display });
}

/**
 * The row's hover text: everything the glyph encodes, spelled out, plus the
 * facts that have no room in a rail this narrow.
 *
 * <p>This is the other half of the row's answer. The row shows what a reader
 * scans for — shape, recency, size — and the hover carries what they ask once
 * they have found the row: which model, how it ended, how long it took. Only
 * lines backed by a recorded fact appear; a session whose file never named a
 * model simply has no model line, rather than a line saying so.</p>
 *
 * @param meta the row's session
 * @param lang the chrome language
 * @param now  the clock the elapsed time is read against
 */
export function sessionTitleLines(meta: SessionMeta, lang: Lang, now: number = Date.now()): string {
  const signal = sessionSignal(meta);
  const lines: string[] = [
    meta.firstPrompt !== "" ? meta.firstPrompt : t(lang, "nav.emptySession"),
    new Date(meta.startedAt).toLocaleString(lang === "de" ? "de-DE" : "en-US"),
  ];

  const model = sessionModelLabel(meta);
  if (model !== "") {
    // Both when both are known and they differ: "ollama · qwen3:8b" answers
    // "who ran this" in one line, and the provider alone is meaningless once a
    // machine has more than one local backend.
    const provider = meta.provider ?? "";
    lines.push(provider !== "" && provider !== "-" && provider !== model ? `${provider} · ${model}` : model);
  }

  lines.push(
    signal.outcome === "clean"
      ? t(lang, "sess.out.clean")
      : signal.outcome === "failed"
        ? t(lang, "sess.out.failed")
        : signal.outcome === "open"
          ? t(lang, "sess.out.open")
          : t(lang, "sess.out.cut", { r: meta.stopReason ?? "?" }),
  );

  if (signal.gate === "denied") {
    lines.push(t(lang, "sess.gateDenied", { n: meta.gateCount ?? 0, d: meta.denyCount ?? 0 }));
  } else if (signal.gate === "asked") {
    lines.push(t(lang, "sess.gateAsked", { n: meta.gateCount ?? 0 }));
  }

  const facts: string[] = [];
  const agents = meta.agentCount ?? 0;
  if (agents > 1) facts.push(countLabel(lang, "agent", agents));
  if ((meta.turnCount ?? 0) > 0) facts.push(countLabel(lang, "turn", meta.turnCount ?? 0));
  facts.push(countLabel(lang, "token", meta.tokens));
  // endedAt is the last recorded event, so this is the span the file covers.
  // A run still in flight has no end yet and gets no duration rather than one
  // measured against the clock on the wall.
  if (meta.endedAt !== undefined && meta.endedAt > meta.startedAt && meta.endedAt <= now) {
    facts.push(t(lang, "sess.ranFor", { d: formatDuration(meta.endedAt - meta.startedAt) }));
  }
  lines.push(facts.join(" · "));
  return lines.join("\n");
}

// ---- the glyph --------------------------------------------------------

/** Slot geometry, in the 20x14 viewBox. Fixed, not measured: a comb that grew
 *  with its bar count would ragged the left edge of every title beside it. */
const BAR_PITCH = 2.7;
const BAR_TOP = 1;
const BAR_HEIGHT = 9;
const COMB_SPAN = 13.1;
const RULE_TOP = 11.5;
const GATE_X = 17;

/**
 * A session's spectrum, read left to right: the comb counts the agents that
 * ran, the line at the right edge is the permission gate, and the rule
 * underneath is how the run ended.
 *
 * <p>No colour is invented here. The comb wears the agent accents the chat and
 * the fleet sigil already use, the gate wears the event token that is the gate
 * everywhere else in the app, and an unfinished run is dimmed with the same
 * faint text token as every other "we do not know" in this UI. A clean run
 * gets no rule at all — an unannotated spectrum is the normal one, and marking
 * the normal case is how a list stops meaning anything.</p>
 */
export function SessionSigil({ signal }: { signal: SessionSignal }) {
  const rule =
    signal.outcome === "failed"
      ? { token: "var(--error)", width: COMB_SPAN }
      : signal.outcome === "cut"
        ? { token: "var(--text-faint)", width: COMB_SPAN }
        : signal.outcome === "open"
          ? { token: "var(--text-faint)", width: COMB_SPAN / 2 }
          : null;
  return (
    <svg className="session-sigil" viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
      {signal.bars.map((bar, i) => (
        <rect
          key={i}
          x={1 + i * BAR_PITCH}
          y={BAR_TOP}
          width={bar.width}
          height={BAR_HEIGHT}
          rx={0.6}
          fill={bar.token}
        />
      ))}
      {signal.more > 0 && (
        <rect
          x={1 + signal.bars.length * BAR_PITCH}
          y={BAR_TOP}
          width={0.8}
          height={BAR_HEIGHT}
          rx={0.4}
          fill="var(--text-faint)"
          opacity={0.55}
        />
      )}
      {signal.gate !== "none" && (
        <rect
          x={GATE_X}
          y={BAR_TOP}
          width={1.3}
          height={BAR_HEIGHT}
          rx={0.6}
          fill="var(--ev-gate)"
          opacity={signal.gate === "denied" ? 1 : 0.4}
        />
      )}
      {rule !== null && <rect x={1} y={RULE_TOP} width={rule.width} height={1} rx={0.5} fill={rule.token} />}
    </svg>
  );
}

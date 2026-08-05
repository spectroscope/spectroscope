// One calm line: making token cost visible is a design principle, not
// decoration. Numbers are tabular so the footer does not jitter mid-stream.
//
// The footer also carries the About entry, at its right end. That corner is
// the app's bottom right on every tab, and the footer is already permanent
// chrome there — so the notice gets the placement it was asked for without a
// fourth floating control appearing over the canvas.

import { useEffect, useState } from "react";
import { AboutDialog } from "./AboutDialog";
import { onAboutRequested } from "../state/aboutSignal";
import type { AgentInfo, RunSubagents, UiState } from "../state/reducer";
import type { ConnectionStatus } from "../transport/ws";
import { formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/**
 * What of the session total belongs to subagents, or null when none of it does.
 *
 * The session total used to be the main agent's bill, because a subagent's
 * tokens never became a frame: measured over ~/.claude/projects, the 230
 * completed Agent launches carry 842,802 output tokens their parents' totals
 * never showed. Counting them is the owner's call and it is made. What is left
 * is the honest half — the same number must not mean two things depending on
 * when the session was imported, so the footer says when children are in it.
 *
 * Null and not a zero row: a session that spawned nothing, and a child whose
 * file never recorded a bill, both have nothing to disclose.
 */
export function subagentShare(
  agents: readonly AgentInfo[],
): { count: number; inTokens: number; outTokens: number } | null {
  const children = agents.filter((a) => a.parentId !== null && a.inTokens + a.outTokens > 0);
  if (children.length === 0) return null;
  return {
    count: children.length,
    inTokens: children.reduce((n, a) => n + a.inTokens, 0),
    outTokens: children.reduce((n, a) => n + a.outTokens, 0),
  };
}

/**
 * The same disclosure for the RUN figure, or null when there is nothing to say.
 *
 * The run total counts a child's tokens the same way the session total does, so
 * it needs the same note; it cannot borrow the session's, which is folded from
 * the roster and therefore covers every run ever seen by this state. The count
 * is of agents — the reducer keeps each child's id once, however often it
 * billed.
 */
export function runShare(run: RunSubagents): { count: number; inTokens: number; outTokens: number } | null {
  if (run.ids.length === 0 || run.inputTokens + run.outputTokens === 0) return null;
  return { count: run.ids.length, inTokens: run.inputTokens, outTokens: run.outputTokens };
}

export function UsageFooter(props: { state: UiState; connection: ConnectionStatus }) {
  const { usage, runUsage, runSubagents, running, lastStopReason, agents } = props.state;
  const share = subagentShare(agents);
  const runPart = runShare(runSubagents);
  const { connection } = props;
  const [aboutOpen, setAboutOpen] = useState(false);
  const lang = useLang();

  // The desktop shell's menu bar opens this same panel from outside React.
  useEffect(() => onAboutRequested(() => setAboutOpen(true)), []);

  const runStatus = running
    ? t(lang, "footer.runActive")
    : lastStopReason !== null && lastStopReason !== "end_turn"
      ? t(lang, "footer.stopped", { r: lastStopReason })
      : t(lang, "footer.ready");

  const connTone = connection === "open" ? "ok" : connection === "connecting" ? "warn" : "error";
  const connLabel =
    connection === "open"
      ? t(lang, "footer.connected")
      : connection === "connecting"
        ? t(lang, "footer.connecting")
        : t(lang, "footer.disconnected");

  return (
    <>
      <footer className="usage-footer">
        <span className="usage tabular">
          {t(lang, "footer.run")} {formatTokens(runUsage.inputTokens)} in &middot;{" "}
          {formatTokens(runUsage.outputTokens)} out
          {runPart !== null && (
            <span
              className="usage-subagents"
              title={t(lang, "footer.runSubagentsTitle", { out: formatTokens(runPart.outTokens) })}
            >
              {" "}
              &middot;{" "}
              {t(lang, runPart.count === 1 ? "footer.subagent" : "footer.subagents", {
                n: runPart.count,
              })}
            </span>
          )}
        </span>
        <span className="footer-diamond" aria-hidden="true">
          &middot;
        </span>
        <span className="usage tabular">
          {t(lang, "footer.session")} {formatTokens(usage.inputTokens)} in &middot;{" "}
          {formatTokens(usage.outputTokens)} out
          {share !== null && (
            <span
              className="usage-subagents"
              title={t(lang, "footer.subagentsTitle", { out: formatTokens(share.outTokens) })}
            >
              {" "}
              &middot;{" "}
              {t(lang, share.count === 1 ? "footer.subagent" : "footer.subagents", { n: share.count })}
            </span>
          )}
        </span>
        <span className="footer-spacer" />
        <span className="footer-status">
          <span className={`dot ${running ? "accent" : "faint"}`} aria-hidden="true" /> {runStatus}
        </span>
        <span className="footer-status">
          <span className={`dot ${connTone}`} aria-hidden="true" /> {connLabel}
        </span>
        <span className="footer-diamond" aria-hidden="true">
          &middot;
        </span>
        <button
          type="button"
          className="about-open"
          aria-haspopup="dialog"
          aria-expanded={aboutOpen}
          title={t(lang, "about.openTitle")}
          onClick={() => setAboutOpen(true)}
        >
          {t(lang, "about.open")}
        </button>
      </footer>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </>
  );
}

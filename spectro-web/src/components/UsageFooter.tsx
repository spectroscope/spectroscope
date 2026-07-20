// One calm line: making token cost visible is a design principle, not
// decoration. Numbers are tabular so the footer does not jitter mid-stream.

import type { UiState } from "../state/reducer";
import type { ConnectionStatus } from "../transport/ws";
import { formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function UsageFooter(props: { state: UiState; connection: ConnectionStatus }) {
  const { usage, runUsage, running, lastStopReason } = props.state;
  const { connection } = props;
  const lang = useLang();

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
    <footer className="usage-footer">
      <span className="usage tabular">
        {t(lang, "footer.run")} {formatTokens(runUsage.inputTokens)} in &middot; {formatTokens(runUsage.outputTokens)}{" "}
        out
      </span>
      <span className="footer-diamond" aria-hidden="true">
        &middot;
      </span>
      <span className="usage tabular">
        {t(lang, "footer.session")} {formatTokens(usage.inputTokens)} in &middot; {formatTokens(usage.outputTokens)} out
      </span>
      <span className="footer-spacer" />
      <span className="footer-status">
        <span className={`dot ${running ? "accent" : "faint"}`} aria-hidden="true" /> {runStatus}
      </span>
      <span className="footer-status">
        <span className={`dot ${connTone}`} aria-hidden="true" /> {connLabel}
      </span>
    </footer>
  );
}

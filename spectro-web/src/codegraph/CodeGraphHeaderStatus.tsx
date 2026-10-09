// Card 472: the header's code graph line. While a build runs it says so, since
// when, and the last line graphify printed; when the build ends well (or the
// session opens on a folder that already has a graph) a "Graph ready" chip
// takes its place, and pressing it opens graph.html of that folder in the
// internal browser. A failed build leaves a "Graph failed" chip that opens the
// last twenty lines, and a graph an earlier build left keeps its ready chip
// beside it.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { requestCodeGraphOpen } from "../state/browserOpen";
import { openDockPanel, openRightPanel } from "../state/layout";
import { headerView, shortTime, type HeaderView } from "./codeGraphModel";
import { openCodeGraphSheet, useCodeGraph } from "./codeGraphStore";
import "../styles/codegraph.css";

/**
 * Opens the session folder's graph in the internal browser panel: the panel
 * opens (and the workspace with it, remembered like a menu press), and the ask
 * waits for the panel's segment to send it. The server mints the one-shot
 * ticket and builds the address on its own port.
 */
export function openGraphInBrowser(sessionId: string): void {
  requestCodeGraphOpen(sessionId);
  openDockPanel("browser");
  openRightPanel(true);
}

/** What a press on the chip does: the graph when it is ready, the failure lines when not. */
export function pressChip(view: HeaderView, sessionId: string | null): void {
  if (view.kind === "failed") {
    openCodeGraphSheet("failure");
    return;
  }
  if (view.kind === "ready" && sessionId !== null) openGraphInBrowser(sessionId);
}

export function CodeGraphHeaderStatus() {
  const lang = useLang();
  const { sessionId, status } = useCodeGraph();
  const view = headerView(status);

  if (view.kind === "none") return null;

  if (view.kind === "running") {
    return (
      <span className="cg-line" role="status" title={view.lastLine ?? undefined}>
        <span className="cg-line-label">{t(lang, "cg.building")}</span>
        <span className="cg-line-since mono">
          {t(lang, "cg.since", { time: shortTime(view.since, lang) })}
        </span>
        {view.lastLine !== null && <span className="cg-line-last mono">{view.lastLine}</span>}
      </span>
    );
  }

  if (view.kind === "ready") {
    return <Chip view={view} sessionId={sessionId} />;
  }
  // A failed build over an older graph: the failure says what happened, and the
  // older graph stays one press away.
  return (
    <>
      <Chip view={view} sessionId={sessionId} />
      {view.graph !== null && <Chip view={{ kind: "ready", at: view.graph.at }} sessionId={sessionId} />}
    </>
  );
}

function Chip({
  view,
  sessionId,
}: {
  view: Extract<HeaderView, { kind: "ready" } | { kind: "failed" }>;
  sessionId: string | null;
}) {
  const lang = useLang();
  const ready = view.kind === "ready";
  const time = ready && view.at !== null ? shortTime(view.at, lang) : "";
  return (
    <button
      type="button"
      className={`cg-chip${ready ? "" : " cg-chip--failed"}`}
      data-codegraph-chip={view.kind}
      title={ready ? t(lang, "cg.readyTitle") : t(lang, "cg.failedTitle")}
      onClick={() => pressChip(view, sessionId)}
    >
      <span>{ready ? t(lang, "cg.ready") : t(lang, "cg.failed")}</span>
      {time !== "" && <span className="cg-chip-time mono">{time}</span>}
    </button>
  );
}

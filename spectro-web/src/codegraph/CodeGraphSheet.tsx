// Card 472: the sheet behind "Build code graph", and the failure lines.
//
// The build sheet asks three things: a full build or an update (update first
// when the folder already has a graph), which provider names the communities
// (the harness's own list from the server, "No labels" first), and which model.
// Start hands the choice to the server, which checks it against the same list
// before anything becomes an argument. When graphify is missing the sheet says
// how to install it and cannot start.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  defaultMode,
  failureLines,
  postCodeGraphStart,
  startBody,
  type CodeGraphStatus,
} from "./codeGraphModel";
import { closeCodeGraphSheet, openCodeGraphSheet, refreshCodeGraph } from "./codeGraphStore";
import "../styles/codegraph.css";

/** The models one provider lists, the same route the model picker reads. */
async function fetchModels(provider: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    if (!res.ok) return [];
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

function CloseButton(props: { onClose: () => void; label: string }) {
  return (
    <button type="button" className="icon-button cg-close" aria-label={props.label} onClick={props.onClose}>
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}

export function CodeGraphSheet(props: {
  status: CodeGraphStatus | null;
  sessionId: string | null;
  view: "build" | "failure";
  onClose: () => void;
}) {
  const lang = useLang();
  const { status, sessionId, onClose } = props;
  const [mode, setMode] = useState<"full" | "update">(defaultMode(status));
  const [modeChosen, setModeChosen] = useState(false);
  const suggested = defaultMode(status);
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The status can land after the sheet opened; until a mode is chosen by
  // hand, the first choice follows it (update for a folder with a graph).
  useEffect(() => {
    if (!modeChosen) setMode(suggested);
  }, [suggested, modeChosen]);

  useEffect(() => {
    if (provider === "") {
      setModels(null);
      setModel("");
      return;
    }
    let live = true;
    setModels(null);
    void fetchModels(provider).then((list) => {
      if (!live) return;
      setModels(list);
      setModel(list[0] ?? "");
    });
    return () => {
      live = false;
    };
  }, [provider]);

  const folder = status?.folder ?? null;

  if (props.view === "failure") {
    const job = status?.job ?? null;
    const lines = failureLines(status);
    return (
      <div className="cg-scrim" onClick={onClose}>
        <section
          className="cg-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t(lang, "cg.failedTitle")}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="cg-head">
            <h2 className="cg-title">{t(lang, "cg.failedTitle")}</h2>
            <CloseButton onClose={onClose} label={t(lang, "common.close")} />
          </header>
          <p className="cg-sub mono">
            {job?.exitCode !== null && job?.exitCode !== undefined
              ? t(lang, "cg.exit", { code: job.exitCode })
              : t(lang, "cg.noExit")}
            {folder !== null ? ` · ${folder}` : ""}
          </p>
          <p className="cg-note">{t(lang, "cg.lastLines", { n: lines.length })}</p>
          <pre className="cg-tail mono">{lines.join("\n")}</pre>
          <footer className="cg-foot">
            <button type="button" className="ghost" onClick={onClose}>
              {t(lang, "common.close")}
            </button>
            <button type="button" className="soft-primary" onClick={() => openCodeGraphSheet("build")}>
              {t(lang, "cg.again")}
            </button>
          </footer>
        </section>
      </div>
    );
  }

  const installed = status?.installed === true;
  const running = status?.job?.state === "running";
  const backends = status?.backends ?? [];
  const modelOk = provider === "" || (models !== null && models.includes(model));
  const canStart = installed && sessionId !== null && !running && !sending && modelOk;

  const start = async (): Promise<void> => {
    if (!canStart || sessionId === null) return;
    setSending(true);
    setMessage(null);
    const answer = await postCodeGraphStart(
      startBody(sessionId, mode, provider === "" ? null : provider, provider === "" ? null : model),
    );
    setSending(false);
    if (answer.status === 202) {
      refreshCodeGraph();
      closeCodeGraphSheet();
      return;
    }
    setMessage(
      answer.message ??
        (answer.status === 0
          ? t(lang, "wchip.unreachable")
          : t(lang, "wchip.failed", { status: answer.status })),
    );
  };

  return (
    <div className="cg-scrim" onClick={onClose}>
      <section
        className="cg-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "cg.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cg-head">
          <h2 className="cg-title">{t(lang, "cg.title")}</h2>
          <CloseButton onClose={onClose} label={t(lang, "common.close")} />
        </header>
        {folder !== null && <p className="cg-sub mono">{folder}</p>}

        {!installed && status !== null && (
          <div className="cg-missing">
            <p>{t(lang, "cg.notInstalled")}</p>
            <code className="cg-install mono">{status.install}</code>
            <p className="cg-note">{t(lang, "cg.notInstalledHint")}</p>
          </div>
        )}

        <fieldset className="cg-field">
          <legend className="cg-legend">{t(lang, "cg.what")}</legend>
          <label className="cg-choice">
            <input
              type="radio"
              name="cg-mode"
              value="full"
              checked={mode === "full"}
              onChange={() => {
                setModeChosen(true);
                setMode("full");
              }}
            />
            <span className="cg-choice-text">
              <span>{t(lang, "cg.full")}</span>
              <span className="cg-note">{t(lang, "cg.fullHint")}</span>
            </span>
          </label>
          <label className="cg-choice">
            <input
              type="radio"
              name="cg-mode"
              value="update"
              checked={mode === "update"}
              onChange={() => {
                setModeChosen(true);
                setMode("update");
              }}
            />
            <span className="cg-choice-text">
              <span>{t(lang, "cg.update")}</span>
              <span className="cg-note">{t(lang, "cg.updateHint")}</span>
            </span>
          </label>
        </fieldset>

        <label className="cg-field cg-select">
          <span className="cg-legend">{t(lang, "cg.names")}</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">{t(lang, "cg.noLabels")}</option>
            {backends.map((b) => (
              <option key={b.provider} value={b.provider} disabled={!b.ready} title={b.reason ?? undefined}>
                {`${b.provider} (${b.backend})`}
              </option>
            ))}
          </select>
        </label>
        {backends.some((b) => !b.ready) && (
          <p className="cg-note">
            {backends
              .filter((b) => !b.ready)
              .map((b) => b.reason)
              .join(" · ")}
          </p>
        )}

        {provider !== "" && (
          <label className="cg-field cg-select">
            <span className="cg-legend">{t(lang, "cg.model")}</span>
            {models === null ? (
              <span className="cg-note">…</span>
            ) : models.length === 0 ? (
              <span className="cg-note">{t(lang, "cg.noModels")}</span>
            ) : (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        {running && <p className="cg-note">{t(lang, "cg.running")}</p>}
        {sessionId === null && <p className="cg-note">{t(lang, "wchip.needsSession")}</p>}
        {message !== null && (
          <p className="cg-error" role="alert">
            {message}
          </p>
        )}

        <footer className="cg-foot">
          <button type="button" className="ghost" onClick={onClose}>
            {t(lang, "cg.cancel")}
          </button>
          <button
            type="button"
            className="soft-primary"
            data-codegraph-start
            disabled={!canStart}
            onClick={() => void start()}
          >
            {t(lang, "cg.start")}
          </button>
        </footer>
      </section>
    </div>
  );
}

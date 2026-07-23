// Starter bundles (card 50): a newcomer picks a ready-made project — five lines,
// a fleet, or a small team — for Gradle or Maven, then either copies the files or
// scaffolds them straight into a folder they pick. The bundles + the scaffold live
// server-side (BundleController); this is only the chooser.

import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

interface BundleInfo {
  id: string;
  name: string;
  description: string;
  fleet: boolean;
}

type BuildTool = "gradle" | "maven";

export function StarterDialog(props: { onClose: () => void }) {
  const lang = useLang();
  const [bundles, setBundles] = useState<BundleInfo[] | null>(null);
  const [version, setVersion] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<BuildTool>("gradle");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [scaffold, setScaffold] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/bundles")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (c) {
          setBundles(c.bundles as BundleInfo[]);
          setVersion(String(c.version ?? ""));
        }
      })
      .catch(() => setBundles([]));
  }, []);

  // Fetch the rendered file set whenever the selection or build tool changes.
  useEffect(() => {
    if (sel === null) {
      setFiles(null);
      return;
    }
    setScaffold(null);
    let alive = true;
    fetch(`/api/bundles/${encodeURIComponent(sel)}?build=${tool}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (alive && c) setFiles(c.files as Record<string, string>);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sel, tool]);

  const copyAll = (): string =>
    Object.entries(files ?? {})
      .map(([path, content]) => `# ${path}\n${content}`)
      .join("\n\n");

  const doScaffold = async (): Promise<void> => {
    if (sel === null) return;
    setBusy(true);
    setScaffold(null);
    try {
      // Pick a folder with the same native chooser as the workspace.
      const pick = await fetch("/api/pick-workspace", { method: "POST" });
      if (pick.status !== 200) {
        setScaffold(pick.status === 204 ? t(lang, "starter.pickCancelled") : t(lang, "starter.pickFailed"));
        return;
      }
      const { path } = (await pick.json()) as { path: string };
      const res = await fetch(`/api/bundles/${encodeURIComponent(sel)}/scaffold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: path, build: tool }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) {
        setScaffold(t(lang, "starter.wrote", { n: body.written?.length ?? 0, dir: body.dir ?? path }));
      } else if (res.status === 409) {
        setScaffold(t(lang, "starter.conflict", { files: (body.conflicts ?? []).join(", ") }));
      } else {
        setScaffold(body.message ?? t(lang, "starter.pickFailed"));
      }
    } catch {
      setScaffold(t(lang, "starter.pickFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal scn-modal" role="dialog" aria-modal="true" aria-labelledby="starter-title">
        <div className="modal-head">
          <span className="eyebrow sand">{t(lang, "starter.kicker")}</span>
        </div>
        <h2 id="starter-title">{t(lang, "starter.title")}</h2>
        <p className="import-hint">
          {t(lang, "starter.hint")}
          {version !== "" && (
            <>
              {" "}
              · <span className="mono">dev.spectroscope:spectro-core:{version}</span>
            </>
          )}
        </p>

        <div className="scn-list">
          {bundles === null ? (
            <p className="ws-note">{t(lang, "starter.loading")}</p>
          ) : (
            bundles.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`scn-row${sel === b.id ? " scn-row--on" : ""}`}
                onClick={() => setSel(sel === b.id ? null : b.id)}
              >
                <span className="scn-name">{b.name}</span>
                <span className="scn-prompt">{b.description}</span>
              </button>
            ))
          )}
        </div>

        {sel !== null && files !== null && (
          <div className="starter-detail">
            <div className="starter-tools">
              {(["gradle", "maven"] as const).map((tl) => (
                <button
                  key={tl}
                  type="button"
                  className={`scn-tab${tool === tl ? " scn-tab--active" : ""}`}
                  onClick={() => setTool(tl)}
                >
                  {tl}
                </button>
              ))}
              <span className="starter-detail-actions">
                <CopyButton text={copyAll} label={t(lang, "starter.copyAll")} />
                <button type="button" className="ghost" disabled={busy} onClick={doScaffold}>
                  {t(lang, "starter.scaffold")}
                </button>
              </span>
            </div>
            {scaffold !== null && <p className="starter-status">{scaffold}</p>}
            <div className="starter-files">
              {Object.entries(files).map(([path, content]) => (
                <div key={path} className="starter-file">
                  <div className="starter-file-head">
                    <span className="mono">{path}</span>
                    <CopyButton text={() => content} />
                  </div>
                  <pre className="ws-text">{content}</pre>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={props.onClose}>
            {t(lang, "common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

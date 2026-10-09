// Card 481: one row per step of a loaded playbook: who performs it, which
// skills it names and whether each is installed, which model choice it runs on
// and what state that provider is in, whether it stays private, which
// documents it takes and hands on, and whether it waits for a nod.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { LoadedPlaybook, PlaybookNode } from "../state/playbooks";

type Step = Extract<PlaybookNode, { kind: "step" }>;

export function StepTable({ loaded }: { loaded: LoadedPlaybook }) {
  const lang = useLang();
  const p = loaded.playbook;
  if (p === null) return null;
  const steps = p.nodes.filter((n): n is Step => n.kind === "step");
  const resolution = new Map(loaded.steps.map((s) => [s.id, s]));
  const docName = (id: string): string => p.documents[id]?.name ?? id;

  return (
    <div className="pb-table-wrap">
      <table className="pb-steps">
        <thead>
          <tr>
            <th>{t(lang, "pb.col.step")}</th>
            <th>{t(lang, "pb.col.performer")}</th>
            <th>{t(lang, "pb.col.skills")}</th>
            <th>{t(lang, "pb.col.model")}</th>
            <th>{t(lang, "pb.col.privacy")}</th>
            <th>{t(lang, "pb.col.consumes")}</th>
            <th>{t(lang, "pb.col.produces")}</th>
            <th>{t(lang, "pb.col.nod")}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const r = resolution.get(s.id);
            const skills = r?.skills ?? s.skills.map((name) => ({ name, installed: false, disabled: false }));
            const model = r?.model ?? null;
            return (
              <tr data-step={s.id} key={s.id}>
                <td className="pb-cell-name">{s.name}</td>
                <td>{t(lang, s.performer === "child" ? "pb.child" : "pb.chat")}</td>
                <td>
                  <ul className="pb-skills">
                    {skills.map((k) => (
                      <li key={k.name} className={k.installed ? "is-installed" : "is-missing"}>
                        <span className="pb-mono">{k.name}</span>{" "}
                        <span className="pb-state">
                          {t(lang, k.installed ? "pb.installed" : "pb.notInstalled")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td>
                  {model !== null && (
                    <span className="pb-model" title={model.reason ?? undefined}>
                      <span className="pb-mono">{model.choice}</span>
                      {model.provider !== null && model.provider !== undefined && (
                        <span className="pb-meta-line pb-mono">
                          {model.provider} {model.model}
                        </span>
                      )}
                      <span className={`pb-state pb-state--${model.state}`}>{model.state}</span>
                    </span>
                  )}
                </td>
                <td data-privacy={s.privacy}>{s.privacy}</td>
                <td>{s.consumes.map(docName).join(", ")}</td>
                <td>{s.produces.map(docName).join(", ")}</td>
                <td data-nod={String(s.nod)}>{t(lang, s.nod ? "pb.yes" : "pb.no")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

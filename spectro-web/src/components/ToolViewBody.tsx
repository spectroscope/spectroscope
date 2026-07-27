// The three faces of a tool call (card 94), rendered from the pure
// describeTool() shape:
//   structured — the default: each tool AS ITSELF (a file with its path, an
//                edit as before/after, a listing as a list, a command in a
//                terminal well). Nothing is dropped; the raw payload is one
//                click away.
//   json       — input and output as collapsible trees (JsonTree, the trace's).
//   raw        — exactly what the card always showed: the two pre blocks.
//
// The look is deliberately light (owner: "filigraner"): hairlines instead of
// boxes, one quiet label per region, the mono well only where content is
// genuinely code.

import type { ToolView } from "./toolViews";
import { describeTool } from "./toolViews";
import { JsonTree } from "./JsonTree";
import { prettyJson } from "../format";
import { t } from "../i18n/i18n";
import { highlight } from "./Highlighted";
import { hlLangForPath } from "../workspace/highlight";
import { useLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

/** Visible clip for long bodies — the full payload lives in raw/json. */
const CLIP_CHARS = 4000;

const cut = (s: string, max = CLIP_CHARS): string =>
  s.length > max ? `${s.slice(0, max)}\n... (truncated)` : s;

/** One labeled region — the hairline label the light look leans on. */
function Region(props: { label: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="tv-region">
      <div className="tv-region-head">
        <span className="tv-label">{props.label}</span>
        {props.meta !== undefined && <span className="tv-meta tabular">{props.meta}</span>}
      </div>
      {props.children}
    </div>
  );
}

/** The structured face — one branch per tool shape. */
function Structured({ view, lang }: { view: ToolView; lang: Lang }) {
  switch (view.kind) {
    case "file":
      return (
        <>
          <Region
            label={t(lang, "tv.file")}
            meta={view.range ?? (view.lineCount > 0 ? t(lang, "tv.lines", { n: view.lineCount }) : undefined)}
          >
            <div className="tv-path mono">{view.path}</div>
          </Region>
          {view.body !== "" && (
            <Region label={t(lang, "tv.content")}>
              <pre className="tv-well mono">{highlight(cut(view.body), hlLangForPath(view.path))}</pre>
            </Region>
          )}
        </>
      );

    case "write":
      return (
        <>
          <Region label={t(lang, "tv.wrote")} meta={view.result}>
            <div className="tv-path mono">{view.path}</div>
          </Region>
          <Region label={t(lang, "tv.content")}>
            <pre className="tv-well mono">{highlight(cut(view.content), hlLangForPath(view.path))}</pre>
          </Region>
        </>
      );

    case "edit":
      return (
        <>
          <Region label={t(lang, "tv.edited")} meta={view.result}>
            <div className="tv-path mono">{view.path}</div>
          </Region>
          <div className="tv-diff">
            <div className="tv-diff-side tv-diff-side--before">
              <span className="tv-label">{t(lang, "tv.before")}</span>
              <pre className="tv-well mono">{cut(view.before)}</pre>
            </div>
            <div className="tv-diff-side tv-diff-side--after">
              <span className="tv-label">{t(lang, "tv.after")}</span>
              <pre className="tv-well mono">{cut(view.after)}</pre>
            </div>
          </div>
        </>
      );

    case "listing":
      return (
        <Region label={t(lang, "tv.listing")} meta={t(lang, "tv.entries", { n: view.entries.length })}>
          <div className="tv-path mono">{view.path}</div>
          <ul className="tv-entries mono">
            {view.entries.map((entry, i) => (
              <li key={i} className={entry.endsWith("/") ? "tv-entry tv-entry--dir" : "tv-entry"}>
                {entry}
              </li>
            ))}
          </ul>
        </Region>
      );

    case "matches":
      return (
        <Region label={t(lang, "tv.matches")} meta={t(lang, "tv.hits", { n: view.lines.length })}>
          <div className="tv-path mono">
            <span className="tv-pattern">{view.pattern}</span>
            {view.path !== null && <span className="tv-in"> · {view.path}</span>}
          </div>
          <ul className="tv-entries mono">
            {view.lines.map((line, i) => (
              <li key={i} className="tv-entry">
                {line}
              </li>
            ))}
          </ul>
        </Region>
      );

    case "command":
      return (
        <>
          <Region label={t(lang, "tv.command")}>
            <div className="tv-cmd mono">
              <span className="tv-prompt" aria-hidden="true">
                $
              </span>
              {highlight(view.command, "shell")}
            </div>
          </Region>
          {view.output !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className={`tv-well tv-term mono${view.failed ? " tv-term--failed" : ""}`}>
                {cut(view.output)}
              </pre>
            </Region>
          )}
        </>
      );

    case "image":
      return (
        <Region label={t(lang, "tv.image")} meta={view.result}>
          <div className="tv-path mono">{view.path}</div>
        </Region>
      );

    case "skill":
      return (
        <>
          <Region label={t(lang, "tv.skill")}>
            <div className="tv-path mono">{view.name}</div>
          </Region>
          {view.body !== "" && (
            <Region label={t(lang, "tv.content")}>
              <pre className="tv-well mono">{cut(view.body)}</pre>
            </Region>
          )}
        </>
      );

    case "generic":
      return (
        <>
          <Region label={t(lang, "tv.input")}>
            <pre className="tv-well mono">{cut(prettyJson(view.input))}</pre>
          </Region>
          {view.output !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className="tv-well mono">{cut(view.output)}</pre>
            </Region>
          )}
        </>
      );
  }
}

/** Output parsed as JSON when it IS JSON — else null (most outputs are text). */
function parseMaybeJson(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function ToolViewBody(props: {
  mode: "structured" | "json" | "raw";
  name: string;
  input: unknown;
  output?: string;
  isError: boolean;
  denied: boolean;
}) {
  const lang = useLang();

  if (props.denied) {
    return <p className="tv-denied">{t(lang, "tool.deniedByUser")}</p>;
  }

  if (props.mode === "structured") {
    return (
      <Structured view={describeTool(props.name, props.input, props.output, props.isError)} lang={lang} />
    );
  }

  if (props.mode === "json") {
    const parsed = props.output !== undefined ? parseMaybeJson(props.output) : null;
    return (
      <>
        <Region label={t(lang, "tv.input")}>
          <JsonTree value={props.input} defaultDepth={2} />
        </Region>
        {props.output !== undefined && (
          <Region label={t(lang, "tv.output")}>
            {parsed !== null ? (
              <JsonTree value={parsed} defaultDepth={2} />
            ) : (
              /* Honest: a text output is not JSON — say so rather than fake a tree. */
              <>
                <p className="tv-note">{t(lang, "tv.notJson")}</p>
                <pre className="tv-well mono">{cut(props.output)}</pre>
              </>
            )}
          </Region>
        )}
      </>
    );
  }

  return (
    <>
      <Region label={t(lang, "tv.input")}>
        <pre className="tv-well mono">{cut(prettyJson(props.input))}</pre>
      </Region>
      <Region label={t(lang, "tv.output")}>
        <pre className={`tv-well mono${props.isError ? " tv-well--error" : ""}`}>
          {props.output === undefined ? t(lang, "tv.pending") : cut(props.output)}
        </pre>
      </Region>
    </>
  );
}

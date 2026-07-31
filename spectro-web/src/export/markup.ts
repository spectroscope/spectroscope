// The two things every renderer in this folder needs before it can write a
// line: how to make a third party's text safe, and what to call things.
//
// They live here rather than in html.ts because there are now two renderers —
// the document (html.ts) and the tool bodies inside it (toolBody.ts) — and
// html.ts calls into toolBody.ts. Left where they were, that call would close a
// cycle; hoisted, both files import downward and neither imports the other back.

import type { Lang } from "../i18n/i18n";
import type { HlLang } from "../workspace/highlight";
import { tokenize } from "../workspace/highlight";

// ---- escaping ---------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Every character that could open markup or close an attribute. One pass, so
 * an ampersand is escaped exactly once, and the same function serves text and
 * attributes — one rule is one rule fewer to get wrong at a call site.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Code as coloured spans, or escaped text when the language is unknown —
 * the same rule the app's Highlighted follows: colouring is a claim about what
 * the characters mean, and a wrong claim about a shell command is worse than
 * no colour at all. The token class comes from a closed union, never from data.
 *
 * @param text the code, verbatim
 * @param lang the tokenizer language, or null to render byte for byte
 * @return escaped markup, safe to interpolate
 */
export function codeHtml(text: string, lang: HlLang | null): string {
  if (lang === null || text === "") return escapeHtml(text);
  return tokenize(text, lang)
    .map((tok) =>
      tok.cls === "plain"
        ? escapeHtml(tok.text)
        : `<span class="hl hl-${tok.cls}">${escapeHtml(tok.text)}</span>`,
    )
    .join("");
}

// ---- chrome strings ---------------------------------------------------------

// Deliberately local, not i18n keys: the export is a file that outlives the
// app it came from, and a missing key would print as a key in a document
// someone mails to a colleague.
//
// The tool-view words are the app's own (i18n `tv.*`) in lower case, because
// every eyebrow in this document is lower case and the stylesheet shouts them
// in unison. What is NOT translated here is anything the payload wrote — a
// field's key, a plan step's status, an option's label. Those are the record.
const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    chat: "chat",
    text: "text feed",
    you: "you",
    reasoning: "reasoning",
    chars: "{n} characters",
    input: "input",
    output: "output",
    events: "{n} events",
    exported: "exported {when}",
    error: "error",
    noResult: "no result",
    allowed: "allowed",
    denied: "denied",
    pending: "pending",
    totals: "{in} in · {out} out",
    ended: "ended: {reason}",
    empty: "This session carries no events.",
    theme: "dark",
    lines: "{n} lines",
    // tool views
    file: "file",
    content: "content",
    wrote: "wrote",
    edited: "edited",
    before: "before",
    after: "after",
    listing: "directory",
    entries: "{n} entries",
    matches: "search",
    hits: "{n} hits",
    command: "command",
    image: "image",
    noImage: "not embedded: the picture stays in the app's image store",
    skill: "skill",
    mcp: "mcp tool",
    agents: "subagents",
    agentsN: "{n} agents",
    plan: "plan",
    steps: "{n} steps",
    taskCreated: "task created",
    taskUpdated: "task updated",
    tasks: "tasks",
    tasksN: "{n} tasks",
    blockedBy: "waiting on {ids}",
    unchanged: "the result named no field: nothing moved",
    question: "question",
    questionsN: "{n} questions",
    optionsN: "{n} options",
    multiSelect: "multiple choice",
    chosen: "chosen",
    answer: "answer",
    dismissed: "closed without choosing",
    unanswered: "not answered",
    fetch: "fetched",
    search: "web search",
    workflow: "workflow",
    phases: "phases",
    phasesN: "{n} phases",
    script: "script",
    outcome: "outcome",
    returned: "returned",
    wfOpen: "launched · no outcome recorded",
    wfFailed: "the launch failed, so no run was started",
    wfUnnamed: "in the outcome: {n} failed, none of them named",
    wfDead: "· {n} failed",
    failures: "failures",
    failuresN: "{n} did not return",
    "run.agents": "agents",
    "run.failed": "failed",
    "run.skipped": "skipped",
    "run.empty": "returned nothing",
    "run.tokens": "tokens",
    "run.tools": "tool calls",
    "run.elapsed": "elapsed",
    args: "arguments",
  },
  de: {
    chat: "Chat",
    text: "Text-Feed",
    you: "du",
    reasoning: "Denken",
    chars: "{n} Zeichen",
    input: "Eingabe",
    output: "Ausgabe",
    events: "{n} events",
    exported: "exportiert {when}",
    error: "Fehler",
    noResult: "kein Ergebnis",
    allowed: "erlaubt",
    denied: "verweigert",
    pending: "offen",
    totals: "{in} rein · {out} raus",
    ended: "beendet: {reason}",
    empty: "Diese Session trägt keine Events.",
    theme: "dunkel",
    lines: "{n} Zeilen",
    // tool views
    file: "Datei",
    content: "Inhalt",
    wrote: "geschrieben",
    edited: "bearbeitet",
    before: "vorher",
    after: "nachher",
    listing: "Verzeichnis",
    entries: "{n} Einträge",
    matches: "Suche",
    hits: "{n} Treffer",
    command: "Kommando",
    image: "Bild",
    noImage: "nicht eingebettet: das Bild bleibt im Bildspeicher der App",
    skill: "Skill",
    mcp: "MCP-Tool",
    agents: "Subagenten",
    agentsN: "{n} Agenten",
    plan: "Plan",
    steps: "{n} Schritte",
    taskCreated: "Aufgabe angelegt",
    taskUpdated: "Aufgabe geändert",
    tasks: "Aufgaben",
    tasksN: "{n} Aufgaben",
    blockedBy: "wartet auf {ids}",
    unchanged: "das Ergebnis nennt kein Feld: nichts hat sich bewegt",
    question: "Frage",
    questionsN: "{n} Fragen",
    optionsN: "{n} Optionen",
    multiSelect: "Mehrfachauswahl",
    chosen: "gewählt",
    answer: "Antwort",
    dismissed: "ohne Auswahl geschlossen",
    unanswered: "nicht beantwortet",
    fetch: "geladen",
    search: "Web-Suche",
    workflow: "Workflow",
    phases: "Phasen",
    phasesN: "{n} Phasen",
    script: "Skript",
    outcome: "Ergebnis",
    returned: "zurückgegeben",
    wfOpen: "gestartet · kein Ergebnis vermerkt",
    wfFailed: "der Start ist fehlgeschlagen, es lief kein Durchgang",
    // Count-neutral: "{n} kamen nicht zurück" reads wrong at one, and one is the
    // commonest number here.
    wfUnnamed: "im Ergebnis: {n} gescheitert, keiner davon benannt",
    wfDead: "· {n} gescheitert",
    failures: "Fehlschläge",
    failuresN: "{n} ohne Rückmeldung",
    "run.agents": "Agenten",
    "run.failed": "gescheitert",
    "run.skipped": "übersprungen",
    "run.empty": "ohne Ergebnis",
    "run.tokens": "Tokens",
    "run.tools": "Tool-Aufrufe",
    "run.elapsed": "Dauer",
    args: "Argumente",
  },
};

/**
 * One chrome word of the document, in the document's own language.
 *
 * @param lang the document language
 * @param key  a key of the table above
 * @param vars values for the {placeholders} the phrase carries
 * @return the phrase, PLAIN TEXT — every caller escapes it
 */
export function label(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = LABELS[lang][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

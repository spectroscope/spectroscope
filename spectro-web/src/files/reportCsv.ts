// Card 605: the files report as CSV (design section 5). UTF-8 with a byte
// order mark so a spreadsheet reads the umlauts, comma separated, quoted as
// RFC 4180 says, CRLF line ends. One row per finding, one per file, then one
// per search or listing. The report model holds files, not single touches, so
// a file row carries what happened to it over the session, its sources, its
// first time and its calls.
//
// The columns level, what, source and finding carry the report's tokens in
// every language, for filtering; clock, detail and destination are written in
// the report's language. A cell that starts like a formula gets an apostrophe.

import type { Lang } from "../i18n/i18n";
import { clockText } from "./axis";
import type { FilesReport, Finding, ReportFile, ReportSearch } from "./report";
import { cutNote, destinationText, findingEvent, reachedDestinations, scrub } from "./reportHtml";

export const CSV_HEADER: readonly string[] = [
  "level",
  "time_s",
  "clock",
  "event",
  "agent",
  "tool",
  "what",
  "source",
  "file",
  "finding",
  "detail",
  "destination",
];

const BOM = "\uFEFF";
const EOL = "\r\n";
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * One CSV cell: an apostrophe before a formula start (`=`, `+`, `-`, `@`, tab,
 * carriage return), then quotes around a cell that holds a comma, a quote or
 * a line break, with each quote doubled.
 */
export function csvCell(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

interface Words {
  lines: (n: number) => string;
  fromCall: (n: number) => string;
  fromPerson: string;
  noHost: string;
  unnamed: string;
  notDelivered: string;
  script: string;
  inline: string;
  email: string;
  iban: string;
  calls: (n: number) => string;
  modelOnly: string;
  namesOnly: string;
}

const W: Record<Lang, Words> = {
  en: {
    lines: (n) => (n === 0 ? "no output recorded" : `${n} ${n === 1 ? "line" : "lines"}`),
    fromCall: (n) => `from event ${n}`,
    fromPerson: "first seen in a message from the person",
    noHost: "host not named",
    unnamed: "files not named by the command",
    notDelivered: "not delivered to a model",
    script: "script",
    inline: "inline code",
    email: "email",
    iban: "iban",
    calls: (n) => `${n} ${n === 1 ? "call" : "calls"}`,
    modelOnly: "only a model's reading names it, not counted",
    namesOnly: "a search or listing: names only, not counted",
  },
  de: {
    lines: (n) => (n === 0 ? "keine Ausgabe aufgezeichnet" : `${n} ${n === 1 ? "Zeile" : "Zeilen"}`),
    fromCall: (n) => `aus Ereignis ${n}`,
    fromPerson: "zuerst in einer Nachricht der Person gesehen",
    noHost: "Host nicht genannt",
    unnamed: "Dateien, die der Befehl nicht nennt",
    notDelivered: "keinem Modell zugestellt",
    script: "Skript",
    inline: "Code auf der Zeile",
    email: "E-Mail",
    iban: "IBAN",
    calls: (n) => `${n} ${n === 1 ? "Aufruf" : "Aufrufe"}`,
    modelOnly: "nur die Lesart eines Modells nennt sie, nicht gezählt",
    namesOnly: "eine Suche oder Auflistung: nur Namen, nicht gezählt",
  },
};

const timeS = (t: number | null): string => (t === null ? "" : t.toFixed(1));
const clock = (lang: Lang, report: FilesReport, t: number | null): string =>
  report.timed && t !== null ? clockText(lang, t) : "";

/** The kind's own words, then the command on a line of its own. */
function detail(lang: Lang, report: FilesReport, f: Finding): string {
  const w = W[lang];
  const parts: string[] = [];
  const creds = f.credentials.map((c) => `${c.label} ${c.rule} ${c.band}`).join("; ");
  switch (f.kind) {
    case "credential-used":
      parts.push(`${creds} ${f.firstSeenCall === null ? w.fromPerson : w.fromCall(f.firstSeenCall)}`);
      break;
    case "credential-result":
    case "credential-input":
      parts.push(creds);
      break;
    case "credential-prompt":
      parts.push(f.agentId !== null && f.reached.length === 0 ? `${creds}; ${w.notDelivered}` : creds);
      break;
    case "env-dump":
      parts.push(creds === "" ? w.lines(f.count) : `${w.lines(f.count)}; ${creds}`);
      break;
    case "network":
      parts.push([f.host ?? w.noHost, ...(f.sendsNamed ? [] : [w.unnamed])].join("; "));
      break;
    case "personal-data":
      parts.push(`${report.personal.email} ${w.email}; ${report.personal.iban} ${w.iban}`);
      break;
    case "unknown-script":
      parts.push(f.file === null ? w.inline : w.script);
      break;
    case "secret-file":
    case "outside":
      break;
  }
  if (f.command !== null)
    parts.push(f.commandCut > 0 ? `${f.command} ${cutNote(lang, f.commandCut)}` : f.command);
  return parts.join("\n");
}

function destination(lang: Lang, report: FilesReport, f: Finding): string {
  return reachedDestinations(report, f)
    .map((d) => destinationText(lang, d))
    .join("; ");
}

function findingRow(lang: Lang, report: FilesReport, f: Finding): string[] {
  const file = f.kind === "network" ? f.sends.join("\n") : (f.file ?? "");
  return [
    f.level,
    timeS(f.t),
    clock(lang, report, f.t),
    String(findingEvent(f)),
    f.agentId === null ? "" : scrub(f.agentId),
    f.tool === null ? "" : scrub(f.tool),
    f.what.join(" "),
    f.source,
    file,
    f.kind,
    detail(lang, report, f),
    destination(lang, report, f),
  ];
}

function fileRow(lang: Lang, report: FilesReport, f: ReportFile): string[] {
  const w = W[lang];
  const modelOnly = f.sources.every((s) => s === "model");
  return [
    f.level,
    timeS(f.firstT),
    clock(lang, report, f.firstT),
    String(f.firstCall),
    "",
    "",
    f.what.join(" "),
    f.sources.join(" "),
    f.label,
    "",
    modelOnly ? `${w.calls(f.calls)}; ${w.modelOnly}` : w.calls(f.calls),
    "",
  ];
}

/** A search or listing: `what` says listed or searched, and it is not counted. */
function searchRow(lang: Lang, report: FilesReport, f: ReportSearch): string[] {
  const w = W[lang];
  return [
    f.level,
    timeS(f.firstT),
    clock(lang, report, f.firstT),
    String(f.firstCall),
    "",
    f.tools.map(scrub).join(" "),
    f.what,
    f.sources.join(" "),
    f.label,
    "",
    `${w.calls(f.calls)}; ${w.namesOnly}`,
    "",
  ];
}

/** The files report as one CSV text: the byte order mark, the header, the findings, the files, the searches. */
export function reportCsv(report: FilesReport, lang: Lang): string {
  const rows = [
    [...CSV_HEADER],
    ...report.findings.map((f) => findingRow(lang, report, f)),
    ...report.files.map((f) => fileRow(lang, report, f)),
    ...report.searches.map((f) => searchRow(lang, report, f)),
  ];
  return BOM + rows.map((row) => row.map(csvCell).join(",") + EOL).join("");
}

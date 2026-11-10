// Card 605: the files report as one self-contained HTML document (design
// section 5, the mockup's layout and section order). It reads only the
// FilesReport. Every inserted string is escaped, and the fields the model
// keeps as recorded (session id, version, agents, tools, models, providers,
// hosts) pass a credential mask first. The document's words are local, in
// English and German (R7), as export/html.ts keeps its chrome local.
//
// No request: inline CSS, no font, no link, no image. One inline script
// shows the light and dark switch; without it the page stays light. Print
// forces the light page.

import { escapeHtml } from "../export/markup";
import type { Lang } from "../i18n/i18n";
import { clockText, timeText } from "./axis";
import type { Destination } from "./destinations";
import type { Source } from "./fold";
import type { Level } from "./levels";
import type {
  CredentialRef,
  FilesReport,
  Finding,
  FindingKind,
  ReportFile,
  ReportSearch,
  What,
} from "./report";
import { QUIET_MASK } from "./report";
import { maskCredentials } from "./secrets";

const esc = escapeHtml;

// ---- Shared with reportCsv.ts ---------------------------------------------------

/**
 * A field the model keeps as recorded, with any credential shape replaced by
 * `[credential: <rule>]`. The model masks titles, paths, commands and hosts
 * itself; this covers the rest.
 */
export const scrub = (text: string): string => maskCredentials(text, () => "credential");

/** The note after a cut command: "(n more characters)". */
export function cutNote(lang: Lang, n: number): string {
  const count = n.toLocaleString(lang);
  return lang === "de" ? `(${count} weitere Zeichen)` : `(${count} more characters)`;
}

/** The name a destination prints under: its model, else its provider. */
export function destinationName(lang: Lang, d: Destination): string {
  return scrub(d.model ?? d.provider ?? W[lang].notRecorded);
}

const LOCAL_SERVERS = new Set(["ollama", "lmstudio", "llamacpp"]);

/** A run_start row of a local server: the address decides where it ran, and it was not recorded. */
const isLocalServer = (d: Destination): boolean =>
  d.where === "unknown" && !d.recorded && d.provider !== null && LOCAL_SERVERS.has(d.provider);

/** Where a destination ran, short: "cloud", "this machine", "a local server". */
export function placeShort(lang: Lang, d: Destination): string {
  const w = W[lang];
  if (isLocalServer(d)) return w.localServer;
  if (d.where === "unknown") return d.recorded ? w.notKnown : w.placeNotRecorded;
  return w.place[d.where];
}

/** A destination row that records neither provider, model nor host (final wave item 6c). */
const unrecorded = (d: Destination): boolean => d.provider === null && d.model === null && d.host === null;

/** A destination as a sentence names it: model and place, or that it was not recorded. */
export function destinationText(lang: Lang, d: Destination): string {
  return unrecorded(d)
    ? W[lang].unrecordedDestination
    : `${destinationName(lang, d)} (${placeShort(lang, d)})`;
}

/** The destinations a finding's content reached, resolved from its keys. */
export function reachedDestinations(report: FilesReport, f: Finding): Destination[] {
  const byKey = new Map(report.destinations.map((d) => [d.key, d]));
  return f.reached.flatMap((key) => byKey.get(key) ?? []);
}

// ---- The document's words -------------------------------------------------------

type Place = Exclude<Destination["where"], "unknown">;

interface Words {
  doc: string;
  kicker: string;
  switch: string;
  meta: { session: string; recorded: string; workspace: string; exported: string; covers: string };
  span: (first: string, last: string, length: string) => string;
  events: (n: string) => string;
  agents: (n: number, names: string) => string;
  noTimes: string;
  noWorkspace: string;
  exported: (when: string, version: string | null) => string;
  covers: string;
  level: Record<Level, string>;
  verdict: string;
  headline: {
    secrets: string;
    envDump: string;
    secretSent: string;
    sensitive: string;
    unknown: string;
    project: string;
    noFiles: string;
    noWorkspace: string;
  };
  /** The sensitive headline from the parts present, in the order given. */
  sensitive: (parts: string[]) => string;
  sensitiveParts: { outside: string; network: (n: number) => string; personal: string; homeOrSystem: string };
  noCredential: string;
  noSecret: string;
  /** What the report checked and found none of; network commands left out when every one ran on this machine. */
  checked: (local: boolean) => string;
  checkedNoWorkspace: (local: boolean) => string;
  /** The network commands of a project-level report, all to this machine (task 11 item 3a). */
  localNetwork: (n: number) => string;
  noWorkspaceLimit: string;
  wentTo: (list: string) => string;
  /** A destination row that records neither provider nor model, as wentTo names it. */
  unrecordedDestination: string;
  modelNote: (n: number) => string;
  kinds: Record<FindingKind, string>;
  headings: {
    destinations: string;
    findings: string;
    levels: string;
    files: string;
    searches: string;
    limits: string;
    method: string;
  };
  searchNote: string;
  searchCols: [string, string, string, string, string, string];
  searchWhat: Record<ReportSearch["what"], string>;
  destIntro: string;
  destNone: string;
  destCols: [string, string, string, string, string, string];
  destNote: string;
  notRecorded: string;
  addressNotRecorded: string;
  badge: Record<Place | "local" | "unknown", string>;
  where: Record<Place, string>;
  localServer: string;
  localServerLong: string;
  placeNotRecorded: string;
  notKnown: string;
  place: Record<Place, string>;
  noFinding: string;
  event: (n: number) => string;
  person: string;
  source: Record<Source, string>;
  rule: Record<string, string>;
  band: (band: string) => string;
  title: (f: Finding) => string;
  body: (f: Finding, ctx: Ctx) => string;
  went: (list: string) => string;
  notDelivered: string;
  levelCols: [string, string, string, string, string];
  levelNote: string;
  levelModel: (n: number) => string;
  fileCols: [string, string, string, string, string, string];
  what: Record<What, string>;
  whatNone: string;
  noFile: string;
  folded: (n: string) => string;
  limits: string[];
  limitModel: string;
  limitPowershell: string;
  method: (placeholders: number, count: string) => string[];
  footer: (version: string | null) => string;
}

/** What a finding's body sentence needs besides the finding. */
interface Ctx {
  tool: string; // escaped markup
  file: string; // escaped markup
  creds: string; // escaped markup
  personal: FilesReport["personal"];
}

const EN_WHAT: Record<What, string> = {
  read: "read",
  changed: "changed",
  created: "created",
  deleted: "deleted",
  sent: "sent",
};
const DE_WHAT: Record<What, string> = {
  read: "gelesen",
  changed: "geändert",
  created: "erstellt",
  deleted: "gelöscht",
  sent: "gesendet",
};

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const EN: Words = {
  doc: "files report",
  kicker: "spectroscope · files report",
  switch: "light / dark",
  meta: {
    session: "session",
    recorded: "recorded",
    workspace: "workspace",
    exported: "exported",
    covers: "covers",
  },
  span: (first, last, length) => `${first} to ${last} (${length})`,
  events: (n) => `${n} events`,
  agents: (n, names) => `${n} ${plural(n, "agent", "agents")}${names === "" ? "" : ` (${names})`}`,
  noTimes: "no times recorded",
  noWorkspace:
    "not recorded; without it, only secret files, system folders and dot folders of a home folder rank above project",
  exported: (when, version) =>
    `${when} by spectroscope${version === null ? "" : ` ${version}`}, from the recorded stream only`,
  covers: "the whole session; the filters of the files tab do not apply",
  level: { critical: "critical", sensitive: "sensitive", unknown: "unknown", project: "project" },
  verdict: "verdict",
  headline: {
    secrets: "Secrets appear in this session.",
    envDump: "A command printed the environment or a stored secret.",
    secretSent: "A command sent a secret file over the network.",
    sensitive: "The session reached beyond the project.",
    unknown: "A script ran whose effect the recording does not show.",
    project: "The files the session touched lie in the project.",
    noFiles: "The recording holds no file the session touched.",
    noWorkspace: "The workspace was not recorded.",
  },
  sensitive: (parts) => `The session ${andList(parts, "and")}.`,
  sensitiveParts: {
    outside: "touched files outside the project",
    network: (n) => (n === 1 ? "ran a network command" : "ran network commands"),
    personal: "received personal data in tool results",
    homeOrSystem: "touched files in system folders or dot folders of a home folder",
  },
  noCredential: "No credential shape was found in the recorded results, inputs or messages.",
  noSecret: "No secret file, no credential and no environment dump was found.",
  checked: (local) =>
    "This report checked for secret files by name, credentials by shape, environment and keychain dumps, " +
    `${local ? "" : "network commands, "}files outside the project, personal data and scripts with unknown effect, ` +
    "and found none of these.",
  checkedNoWorkspace: (local) =>
    "This report checked for secret files by name, credentials by shape, environment and keychain dumps, " +
    `${local ? "" : "network commands, "}files in system folders and dot folders of a home folder, personal data and ` +
    "scripts with unknown effect, and found none of these.",
  localNetwork: (n) =>
    n === 1
      ? "The network command ran only against this machine."
      : `All ${n} network commands ran only against this machine.`,
  noWorkspaceLimit: "Without a workspace it cannot tell which other files belong to the project.",
  wentTo: (list) => `Content from these findings went to ${list}.`,
  unrecordedDestination: "a destination that was not recorded",
  modelNote: (n) =>
    n === 1
      ? "A model's reading names 1 more finding; it is marked model and does not count."
      : `A model's reading names ${n} more findings; they are marked model and do not count.`,
  kinds: {
    "secret-file": "Secret files",
    "credential-result": "Credentials in tool results",
    "credential-input": "Credentials in tool inputs",
    "credential-prompt": "Credentials in messages from the person",
    "credential-used": "Credentials used again",
    "env-dump": "Environment or keychain dumps",
    network: "Network commands",
    outside: "Files outside the project",
    "personal-data": "Personal data in tool results",
    "unknown-script": "Scripts with unknown effect",
  },
  headings: {
    destinations: "Where the content went",
    findings: "Findings",
    levels: "Files by level",
    files: "All files",
    searches: "Searches and listings",
    limits: "What this report cannot see",
    method: "Method",
  },
  searchNote:
    "A search or a listing names paths. It counts in no file row and raises no finding about a file; what its result held is checked like any other result. The level is that of the folder it starts in, and it does not count toward the verdict.",
  searchCols: ["level", "pattern or folder", "what", "tool", "first", "calls"],
  searchWhat: { listed: "listed", searched: "searched" },
  destIntro:
    "Everything a tool returned became part of the conversation, and the conversation went to the model " +
    "with every turn. The table lists each model the session called, from the recorded exchanges.",
  destNone:
    "No exchange with a model was recorded. The table names the provider and model the run started with.",
  destCols: ["model", "provider", "address", "where", "requests", "largest request"],
  destNote:
    "The largest request is the biggest single request body: every turn sends the context again, so a sum " +
    "would count it many times. What a provider keeps after a request is not visible to spectroscope.",
  notRecorded: "not recorded",
  addressNotRecorded: "address not recorded",
  badge: {
    cloud: "cloud",
    "local-cloud": "cloud",
    network: "network",
    "this-machine": "this machine",
    local: "local",
    unknown: "unknown",
  },
  where: {
    cloud: "outside this machine",
    "local-cloud": "relayed to a cloud model",
    network: "another machine on the local network",
    "this-machine": "",
  },
  localServer: "a local server",
  localServerLong: "a local server, address not recorded",
  placeNotRecorded: "place not recorded",
  notKnown: "not known",
  place: {
    cloud: "cloud",
    "local-cloud": "relayed to a cloud model",
    network: "local network",
    "this-machine": "this machine",
  },
  noFinding: "No finding.",
  event: (n) => `event ${n}`,
  person: "person",
  source: { recorded: "recorded", probable: "probable", model: "model" },
  rule: {
    "private-key": "private key",
    "anthropic-key": "Anthropic API key",
    "openai-key": "OpenAI API key",
    "aws-akid": "AWS access key id",
    "github-pat": "GitHub token",
    "google-api-key": "Google API key",
    "slack-token": "Slack token",
    bearer: "bearer token",
    jwt: "JSON web token",
    "url-userinfo": "password in a URL",
    "password-assignment": "password assignment",
    "key-body": "key material",
    position: "value in a credential position of a command",
    "stored-secret": "stored secret a command printed",
  },
  band: (band) => (band === "129+" ? "more than 128 bytes" : `${band.replace("-", " to ")} bytes`),
  title: (f) => {
    switch (f.kind) {
      case "secret-file":
        return f.what.length === 0
          ? "Secret file touched"
          : `Secret file ${andList(whatWords(EN_WHAT, f), "and")}`;
      case "credential-result":
        return "Credential in a tool result";
      case "credential-input":
        return "Credential in a tool input";
      case "credential-prompt":
        return f.agentId === null ? "Credential in a prompt" : "Credential in a message to the agent";
      case "credential-used":
        return "Credential used again";
      case "env-dump":
        return "Environment or keychain dump";
      case "network":
        // Files the command does not name may be more than one.
        if (f.sends.length > 1 || !f.sendsNamed) return "Files sent over the network";
        return f.sends.length === 1 ? "File sent over the network" : "Network command";
      case "outside": {
        const what = f.what.length === 0 ? "Touched" : andList(whatWords(EN_WHAT, f), "and");
        return `${what.charAt(0).toUpperCase()}${what.slice(1)} outside the project`;
      }
      case "personal-data":
        return "Personal data in tool results";
      case "unknown-script":
        return "Script with unknown effect";
    }
  },
  body: (f, c) => {
    const actor = f.command !== null ? "The command" : c.tool;
    switch (f.kind) {
      case "secret-file": {
        const what = f.what.length === 0 ? "may have changed" : andList(whatWords(EN_WHAT, f), "and");
        return `${actor} ${what} ${c.file}. Its name marks it as a secret file.`;
      }
      case "credential-result":
        return `${f.tool === null ? "A tool result" : `The result of ${c.tool}`}${forFile(c, "for")} held ${c.creds}.`;
      case "credential-input":
        return `The input of ${c.tool}${forFile(c, "for")} held ${c.creds}.`;
      case "credential-prompt":
        return f.agentId === null
          ? `A prompt held ${c.creds}.`
          : `A message to the running agent held ${c.creds}.`;
      case "credential-used": {
        const from =
          f.firstSeenCall === null
            ? "first seen in a message from the person,"
            : `from event ${f.firstSeenCall}`;
        return `${c.creds} ${from} appears again in the input of ${c.tool}.`;
      }
      case "env-dump": {
        const lines =
          f.count > 0
            ? `Its output had ${f.count.toLocaleString("en")} ${plural(f.count, "line", "lines")}.`
            : "No output was recorded.";
        const value = c.creds === "" ? "" : ` The output was one value, ${c.creds}.`;
        return `The command prints the environment or a stored secret into its result. ${lines}${value} Variables often carry tokens.`;
      }
      case "network": {
        const host =
          f.host === null ? "a host the line does not name" : `<span class="path">${esc(f.host)}</span>`;
        const files = f.sends.map((s) => `<span class="path">${esc(s)}</span>`);
        let sends = "";
        if (files.length > 0) sends = ` and sends ${andList(files, "and")}`;
        if (!f.sendsNamed) {
          sends +=
            files.length > 0
              ? ", plus files the command does not name"
              : " and sends files the command does not name";
        }
        return `The command contacts ${host}${sends}.`;
      }
      case "outside": {
        const what = f.what.length === 0 ? "may have changed" : andList(whatWords(EN_WHAT, f), "and");
        return `${actor} ${what} ${c.file}, which lies outside the workspace.`;
      }
      case "personal-data": {
        const parts: string[] = [];
        if (c.personal.email > 0) {
          parts.push(
            `${c.personal.email.toLocaleString("en")} ${plural(c.personal.email, "email-shaped string", "email-shaped strings")}`,
          );
        }
        if (c.personal.iban > 0) {
          parts.push(`${c.personal.iban.toLocaleString("en")} ${plural(c.personal.iban, "IBAN", "IBANs")}`);
        }
        return `Tool results held ${andList(parts, "and")}. The report does not print them.`;
      }
      case "unknown-script": {
        const ran = f.file === null ? "ran code given on its own line" : `ran the script ${c.file}`;
        return `The command ${ran}. What it read, changed or sent is not in the recording.`;
      }
    }
  },
  went: (list) => `The content went to ${list}.`,
  notDelivered: "It was recorded but not delivered to a model.",
  levelCols: ["level", "only read", "changed", "created", "deleted"],
  levelNote: "Each file counts once, under the most specific thing that happened to it.",
  levelModel: (n) => ` Files only a model's reading names are left out: model readings not counted (${n}).`,
  fileCols: ["level", "file", "what", "source", "first", "calls"],
  what: {
    read: "read",
    changed: "changed (M)",
    created: "created (A)",
    deleted: "deleted (D)",
    sent: "sent",
  },
  whatNone: "may have changed",
  noFile: "No file.",
  folded: (n) => `${n} more project files, all only read. The CSV lists every file.`,
  limits: [
    "It reads only what the session recorded. A file a script opened, or a request a program made on its own, is not in the recording.",
    "Shell commands go through the same heuristic as the files tab. Its entries are marked probable.",
    "A credential of a shape the rules do not know is not found. A secret file is recognised by its name; its content counts only when a tool returned it.",
    "What a provider stores or logs after a request is outside the recording.",
  ],
  limitModel:
    "A model's reading of a command is a guess. Its entries are marked model and do not count toward the verdict.",
  limitPowershell:
    "PowerShell is read for a few cmdlets only: Invoke-WebRequest and Invoke-RestMethod (and their aliases iwr and irm) as network commands, Get-ChildItem Env:, Get-Item Env: and $env: as environment dumps. Other PowerShell commands are not read.",
  method: (placeholders, count) => [
    `Secret files by name: ${SECRET_NAMES}, ${code("id_rsa")} and the other SSH keys, ${SECRET_TAIL}, anything under ${code(".ssh/")}, ${code(".aws/")} or ${code(".gnupg/")}. Templates such as ${code(".env.example")} stay project files.`,
    `Credentials by shape: ten of the twelve redaction rules spectroscope applies to recorded state. One more rule finds assignments to names that say password, secret, token or key, such as ${code("DB_PASSWORD")}. The other two redaction rules count email-shaped strings and IBANs as personal data; one whose local part is ${code("git")} is a Git remote and does not count.`,
    `Credentials by position: in a network command, a value counts as a credential by where it stands, whatever its shape. That is a URL's user and password, the value of ${code("-u")}, ${code("--user")} and ${code("--proxy-user")} when it holds a password, of an option whose name says password, token, secret or key, except ${code("--key")}, ${code("--key-type")}, ${code("--pubkey")} and ${code("--pinnedpubkey")}, whose values are paths or types, of the headers Authorization, Proxy-Authorization and Cookie and of a header whose name says token, key, secret, auth or pass, and the password of ${code("sshpass -p")}. A query value, and a user name given alone, count only when their name holds key, token, secret, pass, auth, sig, session, sid, code, credential or bearer, or when a rule finds them; otherwise they are not counted and print as ${code(QUIET_MASK)}, or as written when they are a variable or a placeholder. The one value that ${code("gh auth token")}, ${code("op read")}, ${code("pass show")}, ${code("security ... -w")} or ${code("aws configure get")} of an access key, a secret key or a session token printed counts too, when the command printed it itself, not into a pipe or a substitution.`,
    "The report prints no credential that its rules or these positions found, nor its exact length or a hash of it. In a command, a password assignment is masked to the end of its word and a URL's user and password from :// to the last @. Each credential gets a label that counts up in this report, and the same value keeps its label; its size is given as a band of bytes. A secret of a shape the rules do not know, in a place of a command they do not read, can still print in a command. The values stay in the recording on the machine that made it.",
    `Placeholders such as the AWS documentation key ending in ${code("EXAMPLE")}, ${code(DOLLAR_NAME)}, a value in angle brackets or ${code("changeme")} are not counted. This session held ${count} ${plural(placeholders, "placeholder", "placeholders")}.`,
    "Levels: critical for secrets, sensitive for files outside the project, network commands and personal data. A script whose effect the recording does not show is unknown, and files inside the workspace are project. The verdict is the highest level; a model's reading does not count.",
    "Sources: recorded when the tool reported the file, probable when the files tab's heuristic read it from a shell command, model when a model's reading named it.",
    "Times count from the session's first event, as the files tab prints them. An event number is the index of the event in the recording, counted from 0; the app's links use the same number.",
    "Destinations come from the recorded exchanges with a model; a session without them falls back to the provider and model the run started with.",
  ],
  footer: (version) => `spectroscope${version === null ? "" : ` ${version}`} · files report`,
};

const DE: Words = {
  doc: "Dateibericht",
  kicker: "spectroscope · Dateibericht",
  switch: "hell / dunkel",
  meta: {
    session: "Session",
    recorded: "aufgezeichnet",
    workspace: "Arbeitsordner",
    exported: "exportiert",
    covers: "umfasst",
  },
  span: (first, last, length) => `${first} bis ${last} (${length})`,
  events: (n) => `${n} Ereignisse`,
  agents: (n, names) => `${n} ${plural(n, "Agent", "Agenten")}${names === "" ? "" : ` (${names})`}`,
  noTimes: "keine Zeiten aufgezeichnet",
  noWorkspace:
    "nicht aufgezeichnet; ohne ihn liegen nur geheime Dateien, Systemordner und Punktordner eines Home-Ordners über Projekt",
  exported: (when, version) =>
    `${when} von spectroscope${version === null ? "" : ` ${version}`}, nur aus dem aufgezeichneten Strom`,
  covers: "die ganze Session; die Filter des Tabs files gelten nicht",
  level: { critical: "kritisch", sensitive: "sensibel", unknown: "unbekannt", project: "Projekt" },
  verdict: "Urteil",
  headline: {
    secrets: "In dieser Session kommen Geheimnisse vor.",
    envDump: "Ein Befehl hat die Umgebung oder ein gespeichertes Geheimnis ausgegeben.",
    secretSent: "Ein Befehl hat eine geheime Datei über das Netz gesendet.",
    sensitive: "Die Session ging über das Projekt hinaus.",
    unknown: "Ein Skript lief, dessen Wirkung die Aufzeichnung nicht zeigt.",
    project: "Die Dateien, die die Session berührt hat, liegen im Projekt.",
    noFiles: "Die Aufzeichnung enthält keine Datei, die die Session berührt hat.",
    noWorkspace: "Der Arbeitsordner wurde nicht aufgezeichnet.",
  },
  sensitive: (parts) => `Die Session hat ${andList(parts, "und")}.`,
  sensitiveParts: {
    outside: "Dateien außerhalb des Projekts berührt",
    network: (n) => (n === 1 ? "einen Netzwerkbefehl ausgeführt" : "Netzwerkbefehle ausgeführt"),
    personal: "personenbezogene Daten in Werkzeugergebnissen erhalten",
    homeOrSystem: "Dateien in Systemordnern oder Punktordnern eines Home-Ordners berührt",
  },
  noCredential:
    "In den aufgezeichneten Ergebnissen, Eingaben und Nachrichten wurde keine Form von Zugangsdaten gefunden.",
  noSecret: "Keine geheime Datei, keine Zugangsdaten und keine Ausgabe der Umgebung wurden gefunden.",
  checked: (local) =>
    "Dieser Bericht hat geheime Dateien nach Namen, Zugangsdaten nach Form, Ausgaben der Umgebung und " +
    `des Schlüsselbunds, ${local ? "" : "Netzwerkbefehle, "}Dateien außerhalb des Projekts, personenbezogene Daten ` +
    "und Skripte mit unbekannter Wirkung geprüft und nichts davon gefunden.",
  checkedNoWorkspace: (local) =>
    "Dieser Bericht hat geheime Dateien nach Namen, Zugangsdaten nach Form, Ausgaben der Umgebung und " +
    `des Schlüsselbunds, ${local ? "" : "Netzwerkbefehle, "}Dateien in Systemordnern und Punktordnern eines Home-Ordners, ` +
    "personenbezogene Daten und Skripte mit unbekannter Wirkung geprüft und nichts davon gefunden.",
  localNetwork: (n) =>
    n === 1
      ? "Der Netzwerkbefehl richtete sich nur an diesen Rechner."
      : `Alle ${n} Netzwerkbefehle richteten sich nur an diesen Rechner.`,
  noWorkspaceLimit: "Ohne Arbeitsordner kann er nicht sagen, welche übrigen Dateien zum Projekt gehören.",
  wentTo: (list) => `Inhalt aus diesen Befunden ging an ${list}.`,
  unrecordedDestination: "ein Ziel, das nicht aufgezeichnet wurde",
  modelNote: (n) =>
    n === 1
      ? "Die Lesart eines Modells nennt 1 weiteren Befund; er ist als Modell markiert und zählt nicht."
      : `Die Lesart eines Modells nennt ${n} weitere Befunde; sie sind als Modell markiert und zählen nicht.`,
  kinds: {
    "secret-file": "Geheime Dateien",
    "credential-result": "Zugangsdaten in Werkzeugergebnissen",
    "credential-input": "Zugangsdaten in Werkzeugeingaben",
    "credential-prompt": "Zugangsdaten in Nachrichten der Person",
    "credential-used": "Erneut verwendete Zugangsdaten",
    "env-dump": "Ausgaben der Umgebung oder des Schlüsselbunds",
    network: "Netzwerkbefehle",
    outside: "Dateien außerhalb des Projekts",
    "personal-data": "Personenbezogene Daten in Werkzeugergebnissen",
    "unknown-script": "Skripte mit unbekannter Wirkung",
  },
  headings: {
    destinations: "Wohin der Inhalt ging",
    findings: "Befunde",
    levels: "Dateien nach Stufe",
    files: "Alle Dateien",
    searches: "Suchen und Auflistungen",
    limits: "Was dieser Bericht nicht sieht",
    method: "Methode",
  },
  searchNote:
    "Eine Suche oder Auflistung nennt Pfade. Sie zählt in keiner Dateizeile und ergibt keinen Befund über eine Datei; was ihr Ergebnis enthielt, wird wie jedes andere Ergebnis geprüft. Die Stufe ist die des Ordners, in dem sie beginnt, und sie zählt nicht für das Urteil.",
  searchCols: ["Stufe", "Muster oder Ordner", "was", "Werkzeug", "zuerst", "Aufrufe"],
  searchWhat: { listed: "aufgelistet", searched: "durchsucht" },
  destIntro:
    "Alles, was ein Werkzeug zurückgab, wurde Teil des Gesprächs, und das Gespräch ging mit jedem Zug an das " +
    "Modell. Die Tabelle nennt jedes Modell, das die Session aufgerufen hat, aus den aufgezeichneten Austauschen.",
  destNone:
    "Es wurde kein Austausch mit einem Modell aufgezeichnet. Die Tabelle nennt Anbieter und Modell, mit denen der Lauf begann.",
  destCols: ["Modell", "Anbieter", "Adresse", "wo", "Anfragen", "größte Anfrage"],
  destNote:
    "Die größte Anfrage ist der größte einzelne Anfragekörper: jeder Zug schickt den Kontext erneut, eine Summe " +
    "würde ihn also vielfach zählen. Was ein Anbieter nach einer Anfrage behält, sieht spectroscope nicht.",
  notRecorded: "nicht aufgezeichnet",
  addressNotRecorded: "Adresse nicht aufgezeichnet",
  badge: {
    cloud: "Cloud",
    "local-cloud": "Cloud",
    network: "Netz",
    "this-machine": "dieser Rechner",
    local: "lokal",
    unknown: "unbekannt",
  },
  where: {
    cloud: "außerhalb dieses Rechners",
    "local-cloud": "an ein Cloud-Modell weitergeleitet",
    network: "ein anderer Rechner im lokalen Netz",
    "this-machine": "",
  },
  localServer: "ein lokaler Server",
  localServerLong: "ein lokaler Server, Adresse nicht aufgezeichnet",
  placeNotRecorded: "Ort nicht aufgezeichnet",
  notKnown: "unbekannt",
  place: {
    cloud: "Cloud",
    "local-cloud": "an ein Cloud-Modell weitergeleitet",
    network: "lokales Netz",
    "this-machine": "dieser Rechner",
  },
  noFinding: "Kein Befund.",
  event: (n) => `Ereignis ${n}`,
  person: "Person",
  source: { recorded: "aufgezeichnet", probable: "wahrscheinlich", model: "Modell" },
  rule: {
    "private-key": "privater Schlüssel",
    "anthropic-key": "Anthropic-API-Schlüssel",
    "openai-key": "OpenAI-API-Schlüssel",
    "aws-akid": "AWS-Zugriffsschlüssel-ID",
    "github-pat": "GitHub-Token",
    "google-api-key": "Google-API-Schlüssel",
    "slack-token": "Slack-Token",
    bearer: "Bearer-Token",
    jwt: "JSON Web Token",
    "url-userinfo": "Passwort in einer URL",
    "password-assignment": "Passwortzuweisung",
    "key-body": "Schlüsselmaterial",
    position: "Wert an einer Stelle eines Befehls für Zugangsdaten",
    "stored-secret": "gespeichertes Geheimnis, das ein Befehl ausgab",
  },
  band: (band) => (band === "129+" ? "mehr als 128 Byte" : `${band.replace("-", " bis ")} Byte`),
  title: (f) => {
    switch (f.kind) {
      case "secret-file":
        return f.what.length === 0
          ? "Geheime Datei berührt"
          : `Geheime Datei ${andList(whatWords(DE_WHAT, f), "und")}`;
      case "credential-result":
        return "Zugangsdaten in einem Werkzeugergebnis";
      case "credential-input":
        return "Zugangsdaten in einer Werkzeugeingabe";
      case "credential-prompt":
        return f.agentId === null
          ? "Zugangsdaten in einem Prompt"
          : "Zugangsdaten in einer Nachricht an den Agenten";
      case "credential-used":
        return "Zugangsdaten erneut verwendet";
      case "env-dump":
        return "Umgebung oder Schlüsselbund ausgegeben";
      case "network":
        if (f.sends.length > 1 || !f.sendsNamed) return "Dateien über das Netz gesendet";
        return f.sends.length === 1 ? "Datei über das Netz gesendet" : "Netzwerkbefehl";
      case "outside":
        return `Außerhalb des Projekts ${f.what.length === 0 ? "berührt" : andList(whatWords(DE_WHAT, f), "und")}`;
      case "personal-data":
        return "Personenbezogene Daten in Werkzeugergebnissen";
      case "unknown-script":
        return "Skript mit unbekannter Wirkung";
    }
  },
  body: (f, c) => {
    const actor = f.command !== null ? "Der Befehl" : c.tool;
    switch (f.kind) {
      case "secret-file": {
        const what = f.what.length === 0 ? "vielleicht geändert" : andList(whatWords(DE_WHAT, f), "und");
        return `${actor} hat ${c.file} ${what}. Der Name weist sie als geheime Datei aus.`;
      }
      case "credential-result":
        return `${f.tool === null ? "Ein Werkzeugergebnis" : `Das Ergebnis von ${c.tool}`}${forFile(c, "zu")} enthielt ${c.creds}.`;
      case "credential-input":
        return `Die Eingabe von ${c.tool}${forFile(c, "zu")} enthielt ${c.creds}.`;
      case "credential-prompt":
        return f.agentId === null
          ? `Ein Prompt enthielt ${c.creds}.`
          : `Eine Nachricht an den laufenden Agenten enthielt ${c.creds}.`;
      case "credential-used": {
        const from =
          f.firstSeenCall === null
            ? "zuerst in einer Nachricht der Person gesehen,"
            : `aus Ereignis ${f.firstSeenCall}`;
        return `${c.creds} ${from} steht erneut in der Eingabe von ${c.tool}.`;
      }
      case "env-dump": {
        const lines =
          f.count > 0
            ? `Die Ausgabe hatte ${f.count.toLocaleString("de")} ${plural(f.count, "Zeile", "Zeilen")}.`
            : "Es wurde keine Ausgabe aufgezeichnet.";
        const value = c.creds === "" ? "" : ` Die Ausgabe war ein einzelner Wert, ${c.creds}.`;
        return `Der Befehl gibt die Umgebung oder ein gespeichertes Geheimnis in sein Ergebnis aus. ${lines}${value} Variablen tragen oft Tokens.`;
      }
      case "network": {
        // A relative clause in the middle of the sentence closes with a comma.
        const more = f.sends.length > 0 || !f.sendsNamed;
        const host =
          f.host === null
            ? `einen Host, den die Zeile nicht nennt${more ? "," : ""}`
            : `<span class="path">${esc(f.host)}</span>`;
        const files = f.sends.map((s) => `<span class="path">${esc(s)}</span>`);
        let sends = "";
        if (files.length > 0) sends = ` und sendet ${andList(files, "und")}`;
        if (!f.sendsNamed) {
          sends +=
            files.length > 0
              ? ", dazu Dateien, die der Befehl nicht nennt"
              : " und sendet Dateien, die der Befehl nicht nennt";
        }
        return `Der Befehl kontaktiert ${host}${sends}.`;
      }
      case "outside": {
        const what = f.what.length === 0 ? "vielleicht geändert" : andList(whatWords(DE_WHAT, f), "und");
        return `${actor} hat ${c.file} außerhalb des Arbeitsordners ${what}.`;
      }
      case "personal-data": {
        const parts: string[] = [];
        if (c.personal.email > 0) {
          parts.push(
            `${c.personal.email.toLocaleString("de")} ${plural(c.personal.email, "E-Mail-förmige Zeichenkette", "E-Mail-förmige Zeichenketten")}`,
          );
        }
        if (c.personal.iban > 0) {
          parts.push(`${c.personal.iban.toLocaleString("de")} ${plural(c.personal.iban, "IBAN", "IBANs")}`);
        }
        return `Werkzeugergebnisse enthielten ${andList(parts, "und")}. Der Bericht gibt sie nicht aus.`;
      }
      case "unknown-script": {
        const ran =
          f.file === null ? "Code direkt auf seiner Zeile ausgeführt" : `das Skript ${c.file} ausgeführt`;
        return `Der Befehl hat ${ran}. Was es gelesen, geändert oder gesendet hat, steht nicht in der Aufzeichnung.`;
      }
    }
  },
  went: (list) => `Der Inhalt ging an ${list}.`,
  notDelivered: "Sie wurde aufgezeichnet, aber keinem Modell zugestellt.",
  levelCols: ["Stufe", "nur gelesen", "geändert", "erstellt", "gelöscht"],
  levelNote: "Jede Datei zählt einmal, unter dem genauesten, was mit ihr geschah.",
  levelModel: (n) =>
    ` Dateien, die nur die Lesart eines Modells nennt, fehlen: Lesarten eines Modells nicht gezählt (${n}).`,
  fileCols: ["Stufe", "Datei", "was", "Quelle", "zuerst", "Aufrufe"],
  what: {
    read: "gelesen",
    changed: "geändert (M)",
    created: "erstellt (A)",
    deleted: "gelöscht (D)",
    sent: "gesendet",
  },
  whatNone: "vielleicht geändert",
  noFile: "Keine Datei.",
  folded: (n) => `${n} weitere Projektdateien, alle nur gelesen. Die CSV-Datei führt jede Datei auf.`,
  limits: [
    "Er liest nur, was die Session aufgezeichnet hat. Eine Datei, die ein Skript geöffnet hat, oder eine Anfrage, die ein Programm selbst gestellt hat, steht nicht in der Aufzeichnung.",
    "Shell-Befehle laufen durch dieselbe Heuristik wie der Tab files. Ihre Einträge sind als wahrscheinlich markiert.",
    "Zugangsdaten in einer Form, die die Regeln nicht kennen, werden nicht gefunden. Eine geheime Datei wird an ihrem Namen erkannt; ihr Inhalt zählt nur, wenn ein Werkzeug ihn zurückgegeben hat.",
    "Was ein Anbieter nach einer Anfrage speichert oder protokolliert, liegt außerhalb der Aufzeichnung.",
  ],
  limitModel:
    "Die Lesart eines Modells ist eine Vermutung. Ihre Einträge sind als Modell markiert und zählen nicht für das Urteil.",
  limitPowershell:
    "PowerShell wird nur für wenige Cmdlets gelesen: Invoke-WebRequest und Invoke-RestMethod (mit ihren Aliasen iwr und irm) als Netzwerkbefehle, Get-ChildItem Env:, Get-Item Env: und $env: als Ausgaben der Umgebung. Andere PowerShell-Befehle werden nicht gelesen.",
  // The German noun is the same in the singular and the plural.
  method: (_placeholders, count) => [
    `Geheime Dateien nach Namen: ${SECRET_NAMES}, ${code("id_rsa")} und die anderen SSH-Schlüssel, ${SECRET_TAIL}, alles unter ${code(".ssh/")}, ${code(".aws/")} oder ${code(".gnupg/")}. Vorlagen wie ${code(".env.example")} bleiben Projektdateien.`,
    `Zugangsdaten nach Form: zehn der zwölf Schwärzungsregeln, die spectroscope auf aufgezeichneten Zustand anwendet. Eine weitere Regel findet Zuweisungen an Namen, die Passwort, Geheimnis, Token oder Schlüssel sagen (englisch geschrieben), etwa ${code("DB_PASSWORD")}. Die zwei übrigen Schwärzungsregeln zählen E-Mail-förmige Zeichenketten und IBANs als personenbezogene Daten; eine mit dem lokalen Teil ${code("git")} ist ein Git-Remote und zählt nicht.`,
    `Zugangsdaten nach Stelle: in einem Netzwerkbefehl zählt ein Wert durch die Stelle, an der er steht, als Zugangsdaten, gleich welche Form er hat. Das sind Benutzer und Passwort einer URL, der Wert von ${code("-u")}, ${code("--user")} und ${code("--proxy-user")}, wenn er ein Passwort enthält, einer Option, deren Name Passwort, Token, Geheimnis oder Schlüssel sagt (englisch geschrieben), außer ${code("--key")}, ${code("--key-type")}, ${code("--pubkey")} und ${code("--pinnedpubkey")}, deren Werte Pfade oder Typen sind, der Header Authorization, Proxy-Authorization und Cookie und eines Headers, dessen Name token, key, secret, auth oder pass enthält, und das Passwort von ${code("sshpass -p")}. Ein Wert einer Abfrage und ein Benutzername allein zählen nur, wenn ihr Name key, token, secret, pass, auth, sig, session, sid, code, credential oder bearer enthält oder eine Regel sie findet; sonst zählen sie nicht und stehen als ${code(QUIET_MASK)} im Befehl, eine Variable oder ein Platzhalter so, wie sie geschrieben wurden. Der eine Wert, den ${code("gh auth token")}, ${code("op read")}, ${code("pass show")}, ${code("security ... -w")} oder ${code("aws configure get")} für einen Zugriffsschlüssel, einen geheimen Schlüssel oder ein Sitzungstoken ausgab, zählt ebenso, wenn der Befehl ihn selbst ausgab, nicht in eine Pipe oder eine Befehlsersetzung.`,
    "Keine Zugangsdaten werden ausgegeben, auch nicht ihre genaue Länge oder ein Hash davon. Das gilt für alle Zugangsdaten, die die Regeln oder diese Stellen gefunden haben. In einem Befehl wird eine Passwortzuweisung bis zum Ende ihres Worts geschwärzt und Benutzer und Passwort einer URL von :// bis zum letzten @. Jeder Wert bekommt ein Etikett, das in diesem Bericht hochzählt, und derselbe Wert behält sein Etikett; seine Größe steht als Spanne in Byte da. Ein Geheimnis in einer Form, die die Regeln nicht kennen, an einer Stelle eines Befehls, die sie nicht lesen, kann in einem Befehl trotzdem erscheinen. Die Werte bleiben in der Aufzeichnung auf dem Rechner, der sie gemacht hat.",
    `Platzhalter wie der AWS-Dokumentationsschlüssel mit der Endung ${code("EXAMPLE")}, ${code(DOLLAR_NAME)}, ein Wert in spitzen Klammern oder ${code("changeme")} zählen nicht. Diese Session enthielt ${count} Platzhalter.`,
    "Stufen: kritisch für Geheimnisse, sensibel für Dateien außerhalb des Projekts, Netzwerkbefehle und personenbezogene Daten. Ein Skript, dessen Wirkung die Aufzeichnung nicht zeigt, ist unbekannt, Dateien im Arbeitsordner sind Projekt. Das Urteil ist die höchste Stufe; die Lesart eines Modells zählt nicht.",
    "Quellen: aufgezeichnet, wenn das Werkzeug die Datei gemeldet hat, wahrscheinlich, wenn die Heuristik des Tabs files sie aus einem Shell-Befehl gelesen hat, Modell, wenn die Lesart eines Modells sie nennt.",
    "Zeiten zählen ab dem ersten Ereignis der Session, so wie der Tab files sie zeigt. Eine Ereignisnummer ist der Index des Ereignisses in der Aufzeichnung, gezählt ab 0; die Links der App verwenden dieselbe Nummer.",
    "Die Ziele kommen aus den aufgezeichneten Austauschen mit einem Modell; ohne sie nennt der Bericht Anbieter und Modell, mit denen der Lauf begann.",
  ],
  footer: (version) => `spectroscope${version === null ? "" : ` ${version}`} · Dateibericht`,
};

const W: Record<Lang, Words> = { en: EN, de: DE };

const code = (text: string): string => `<code>${esc(text)}</code>`;
const DOLLAR_NAME = "$" + "{NAME}";
const SECRET_NAMES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "*.kdbx"]
  .map(code)
  .join(", ");
const SECRET_TAIL = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials",
  "secrets.*",
  "kubeconfig",
]
  .map(code)
  .join(", ");

function whatWords(words: Record<What, string>, f: Finding): string[] {
  return f.what.map((w) => words[w]);
}

/** " for <file>" when the finding names a file. */
const forFile = (c: Ctx, word: string): string => (c.file === "" ? "" : ` ${word} ${c.file}`);

// ---- Markup helpers -------------------------------------------------------------

/** Escaped text with each mask label set off: `[credential 1: aws-akid]` and the scrub's `[credential: rule]`. */
function masked(text: string): string {
  return esc(text).replace(/\[credential(?: \d+)?: [a-z-]+\]/g, (m) => `<span class="masked">${m}</span>`);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const utcDate = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const utcTime = (d: Date, seconds: boolean): string =>
  `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${seconds ? `:${pad2(d.getUTCSeconds())}` : ""}`;

function bytesText(lang: Lang, n: number): string {
  if (n < 1000) return `${n.toLocaleString(lang)} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000).toLocaleString(lang)} kB`;
  return `${(n / 1_000_000).toLocaleString(lang, { maximumFractionDigits: 1 })} MB`;
}

const levelBadge = (lang: Lang, level: Level, text = W[lang].level[level]): string =>
  `<span class="lv lv-${level}">${esc(text)}</span>`;

function sourceSpan(lang: Lang, source: Source): string {
  const cls = source === "recorded" ? "src" : `src src-${source}`;
  return `<span class="${cls}">${esc(W[lang].source[source])}</span>`;
}

/** The event a finding points at: its tool call, else where it was seen (a prompt, a steering message). */
export const findingEvent = (f: Finding): number => f.callIndex ?? f.eventIndex;

/** "+3:12 · event 14 · main" for a finding; parts the finding does not have are left out. */
function when(lang: Lang, report: FilesReport, f: Finding): string {
  const w = W[lang];
  const parts: string[] = [];
  if (report.timed && f.t !== null) parts.push(`+${clockText(lang, f.t)}`);
  parts.push(w.event(findingEvent(f)));
  if (f.agentId !== null) parts.push(scrub(f.agentId));
  else if (f.kind === "credential-prompt") parts.push(w.person);
  return esc(parts.join(" · "));
}

/** "credential 1 (AWS access key id, 17 to 32 bytes) and credential 2 (...)". */
function credentialsText(lang: Lang, refs: readonly CredentialRef[]): string {
  const w = W[lang];
  const items = refs.map(
    (r) =>
      `<span class="masked">${esc(r.label)}</span> (${esc(w.rule[r.rule] ?? r.rule)}, ${esc(w.band(r.band))})`,
  );
  return andList(items, lang === "de" ? "und" : "and");
}

/** The printed command with the count of what was cut, or "" for none. */
function commandBlock(lang: Lang, f: Finding): string {
  if (f.command === null) return "";
  const cut = f.commandCut > 0 ? ` <span class="cut">${esc(cutNote(lang, f.commandCut))}</span>` : "";
  return `<pre class="cmd">${masked(f.command)}${cut}</pre>\n`;
}

function reachedList(lang: Lang, report: FilesReport, f: Finding): string {
  return reachedDestinations(report, f)
    .map((d) => destinationMarkup(lang, d))
    .join(", ");
}

/** destinationText as markup: the model in code. */
function destinationMarkup(lang: Lang, d: Destination): string {
  return unrecorded(d)
    ? esc(W[lang].unrecordedDestination)
    : `${code(destinationName(lang, d))} (${esc(placeShort(lang, d))})`;
}

// ---- Sections -------------------------------------------------------------------

function headerSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const title = report.title ?? scrub(report.sessionId);
  let recorded = w.noTimes;
  if (report.firstTs !== null && report.lastTs !== null) {
    const first = new Date(report.firstTs);
    const last = new Date(report.lastTs);
    const sameDay = utcDate(first) === utcDate(last);
    const lastText = sameDay ? utcTime(last, true) : `${utcDate(last)} ${utcTime(last, true)}`;
    recorded = w.span(
      `${utcDate(first)} ${utcTime(first, true)}`,
      `${lastText} UTC`,
      timeText(lang, (report.lastTs - report.firstTs) / 1000),
    );
  }
  const agents = report.agents.map(scrub);
  const names = agents.length <= 5 ? agents.join(", ") : "";
  recorded += `, ${w.events(report.events.toLocaleString(lang))}, ${w.agents(agents.length, names)}`;
  const exported = new Date(report.exportedAt);
  const version = report.version === null ? null : scrub(report.version);
  const workspace =
    report.workspace === null
      ? `<dd>${esc(w.noWorkspace)}</dd>`
      : `<dd class="path">${masked(report.workspace)}</dd>`;
  return `<header data-section="header">
<p class="kicker">${esc(w.kicker)}</p>
<h1>${masked(title)}</h1>
<dl class="meta">
<dt>${esc(w.meta.session)}</dt><dd>${esc(scrub(report.sessionId))}</dd>
<dt>${esc(w.meta.recorded)}</dt><dd>${esc(recorded)}</dd>
<dt>${esc(w.meta.workspace)}</dt>${workspace}
<dt>${esc(w.meta.exported)}</dt><dd>${esc(w.exported(`${utcDate(exported)} ${utcTime(exported, false)} UTC`, version))}</dd>
<dt>${esc(w.meta.covers)}</dt><dd>${esc(w.covers)}</dd>
</dl>
</header>`;
}

/** The findings a verdict counts: a model's reading does not (R6). */
const counted = (report: FilesReport): Finding[] => report.findings.filter((f) => f.source !== "model");

/** A sentence of the verdict, as plain text and as markup. */
interface Sentence {
  text: string;
  html: string;
}

const plainSentence = (text: string): Sentence => ({ text, html: esc(text) });

/** The critical headline from the kinds present: secrets first, then a dump, then a secret file sent. */
function criticalHeadline(w: Words, real: readonly Finding[]): { headline: string; next: Sentence[] } {
  const critical = real.filter((f) => f.level === "critical");
  if (critical.some((f) => f.kind === "secret-file" || f.kind.startsWith("credential-"))) {
    return { headline: w.headline.secrets, next: [] };
  }
  if (critical.some((f) => f.kind === "env-dump")) {
    return { headline: w.headline.envDump, next: [plainSentence(w.noCredential)] };
  }
  if (critical.some((f) => f.kind === "network")) return { headline: w.headline.secretSent, next: [] };
  return { headline: w.headline.secrets, next: [] };
}

/** The sensitive headline from the kinds present; a sensitive file without an outside finding is a B1 path. */
function sensitiveHeadline(w: Words, report: FilesReport, real: readonly Finding[]): string {
  const sensitive = real.filter((f) => f.level === "sensitive");
  const outside = new Set(sensitive.filter((f) => f.kind === "outside").map((f) => f.file));
  const network = sensitive.filter((f) => f.kind === "network").length;
  const parts: string[] = [];
  if (outside.size > 0) parts.push(w.sensitiveParts.outside);
  const others = report.files.some(
    (f) => f.level === "sensitive" && f.sources.some((s) => s !== "model") && !outside.has(f.label),
  );
  if (others) parts.push(w.sensitiveParts.homeOrSystem);
  if (network > 0) parts.push(w.sensitiveParts.network(network));
  if (sensitive.some((f) => f.kind === "personal-data")) parts.push(w.sensitiveParts.personal);
  return parts.length === 0 ? w.headline.sensitive : w.sensitive(parts);
}

/** The verdict's headline and the sentences after it, chosen from the level and the kinds present. */
function verdictText(lang: Lang, report: FilesReport): { headline: string; sentences: Sentence[] } {
  const w = W[lang];
  const real = counted(report);
  const sentences: Sentence[] = [];
  let headline: string;
  switch (report.verdict) {
    case "critical": {
      const chosen = criticalHeadline(w, real);
      headline = chosen.headline;
      sentences.push(...chosen.next);
      const reached = new Map<string, Destination>();
      for (const f of real) {
        if (f.level !== "critical") continue;
        for (const d of reachedDestinations(report, f)) reached.set(d.key, d);
      }
      if (reached.size > 0) {
        const list = [...reached.values()];
        // A row that records neither provider, model nor host is named as such, without a place.
        const text = list.map((d) => destinationText(lang, d)).join(", ");
        const html = list.map((d) => destinationMarkup(lang, d)).join(", ");
        sentences.push({ text: w.wentTo(text), html: w.wentTo(html) });
      }
      break;
    }
    case "sensitive":
      headline = sensitiveHeadline(w, report, real);
      sentences.push(plainSentence(w.noSecret));
      break;
    case "unknown":
      headline = w.headline.unknown;
      sentences.push(plainSentence(w.noSecret));
      break;
    case "project": {
      const noFiles = !report.files.some((f) => f.sources.some((s) => s !== "model"));
      if (noFiles) headline = w.headline.noFiles;
      else headline = report.workspace === null ? w.headline.noWorkspace : w.headline.project;
      // Every network command of a project-level report ran on this machine (final wave item 4c).
      const local = real.filter((f) => f.kind === "network").length;
      if (report.workspace === null) {
        sentences.push(plainSentence(w.checkedNoWorkspace(local > 0)), plainSentence(w.noWorkspaceLimit));
      } else {
        sentences.push(plainSentence(w.checked(local > 0)));
      }
      if (local > 0) sentences.push(plainSentence(w.localNetwork(local)));
      break;
    }
  }
  const model = report.findings.length - real.length;
  if (model > 0) sentences.push(plainSentence(w.modelNote(model)));
  return { headline, sentences };
}

/**
 * The verdict's headline and its first sentence as plain text, for the
 * report sheet of the files tab. It names models and labels, never a value.
 */
export function verdictLine(report: FilesReport, lang: Lang): string {
  const { headline, sentences } = verdictText(lang, report);
  return sentences.length === 0 ? headline : `${headline} ${sentences[0].text}`;
}

function verdictSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const real = counted(report);
  const { headline, sentences } = verdictText(lang, report);
  const lines = [`<b>${esc(headline)}</b>`, ...sentences.map((s) => s.html)];

  // One line per kind, in the order the findings stand (level, then time).
  const kinds: FindingKind[] = [];
  for (const f of real) if (!kinds.includes(f.kind)) kinds.push(f.kind);
  const items = kinds.map((kind) => {
    const of = real.filter((f) => f.kind === kind);
    let detail: string;
    if (kind.startsWith("credential-")) {
      const labels: string[] = [];
      for (const f of of) for (const c of f.credentials) if (!labels.includes(c.label)) labels.push(c.label);
      detail = labels.map((l) => `<span class="masked">${esc(l)}</span>`).join(", ");
    } else if (kind === "personal-data") {
      detail = esc((report.personal.email + report.personal.iban).toLocaleString(lang));
    } else {
      detail = esc(of.length.toLocaleString(lang));
    }
    return `<li>${esc(w.kinds[kind])}: ${detail}</li>`;
  });
  const list = items.length === 0 ? "" : `\n<ul>\n${items.join("\n")}\n</ul>`;
  return `<section class="verdict verdict-${report.verdict}" data-section="verdict" aria-label="${esc(w.verdict)}">
<p class="level">${esc(w.level[report.verdict])}</p>
<p>${lines.join(" ")}</p>${list}
</section>`;
}

function destinationsSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const anyRecorded = report.destinations.some((d) => d.recorded);
  const head = w.destCols.map((c, i) => `<th${i >= 4 ? ' class="num"' : ""}>${esc(c)}</th>`).join("");
  const rows = report.destinations.map((d) => {
    const model = d.model === null ? esc(w.notRecorded) : code(scrub(d.model));
    const provider = esc(d.provider === null ? w.notRecorded : scrub(d.provider));
    const address =
      d.host === null
        ? `<td>${esc(w.addressNotRecorded)}</td>`
        : `<td class="path">${esc(scrub(d.host))}</td>`;
    let where: string;
    if (isLocalServer(d)) where = `${levelBadge(lang, "unknown", w.badge.local)} ${esc(w.localServerLong)}`;
    else if (d.where === "unknown") {
      where = `${levelBadge(lang, "unknown", w.badge.unknown)} ${esc(d.recorded ? w.notKnown : w.placeNotRecorded)}`;
    } else {
      const level: Level =
        d.where === "this-machine" ? "project" : d.where === "network" ? "sensitive" : "critical";
      const text = w.where[d.where];
      where = `${levelBadge(lang, level, w.badge[d.where])}${text === "" ? "" : ` ${esc(text)}`}`;
    }
    const requests = d.recorded ? esc(d.requests.toLocaleString(lang)) : "";
    const largest = d.recorded && d.largestRequest !== null ? esc(bytesText(lang, d.largestRequest)) : "";
    return `<tr data-destination><td>${model}</td><td>${provider}</td>${address}<td>${where}</td><td class="num">${requests}</td><td class="num">${largest}</td></tr>`;
  });
  return `<section data-section="destinations">
<h2>${esc(w.headings.destinations)}</h2>
<p class="note">${esc(anyRecorded ? w.destIntro : w.destNone)}</p>
<div class="wrap"><table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
<p class="note">${esc(w.destNote)}</p>
</section>`;
}

function findingArticle(lang: Lang, report: FilesReport, f: Finding): string {
  const w = W[lang];
  const ctx: Ctx = {
    tool: f.tool === null ? "" : code(scrub(f.tool)),
    file: f.file === null ? "" : `<span class="path">${masked(f.file)}</span>`,
    creds: credentialsText(lang, f.credentials),
    personal: report.personal,
  };
  const reached = reachedList(lang, report, f);
  let after = "";
  if (reached !== "") after = `<p>${w.went(reached)}</p>\n`;
  else if (f.kind === "credential-prompt" && f.agentId !== null) after = `<p>${esc(w.notDelivered)}</p>\n`;
  return `<article class="finding" data-kind="${f.kind}">
<header>${levelBadge(lang, f.level)}<b>${esc(w.title(f))}</b>${sourceSpan(lang, f.source)}<span class="when">${when(lang, report, f)}</span></header>
<p>${w.body(f, ctx)}</p>
${commandBlock(lang, f)}${after}</article>`;
}

function findingsSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const body =
    report.findings.length === 0
      ? `<p class="none">${esc(w.noFinding)}</p>`
      : report.findings.map((f) => findingArticle(lang, report, f)).join("\n");
  return `<section data-section="findings">
<h2>${esc(w.headings.findings)}</h2>
${body}
</section>`;
}

const LEVEL_ROWS: readonly Level[] = ["critical", "sensitive", "project"];

function levelsSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const modelOnly = report.files.filter((f) => f.sources.every((s) => s === "model")).length;
  const head = w.levelCols.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = LEVEL_ROWS.map((level) => {
    const c = report.counts[level];
    const cells = [c.read, c.changed, c.created, c.deleted].map(
      (n) => `<td>${esc(n.toLocaleString(lang))}</td>`,
    );
    return `<tr><td>${levelBadge(lang, level)}</td>${cells.join("")}</tr>`;
  });
  const note = w.levelNote + (modelOnly > 0 ? w.levelModel(modelOnly) : "");
  return `<section data-section="levels">
<h2>${esc(w.headings.levels)}</h2>
<div class="wrap"><table class="matrix">
<thead><tr>${head}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
<p class="note">${esc(note)}</p>
</section>`;
}

/** Project files that were only read, shown before the rest of them fold into one line. */
const READ_ONLY_SHOWN = 25;

const onlyRead = (f: ReportFile): boolean =>
  f.level === "project" && f.what.length === 1 && f.what[0] === "read";

function fileRow(lang: Lang, report: FilesReport, f: ReportFile): string {
  const w = W[lang];
  const what = f.what.length === 0 ? w.whatNone : f.what.map((k) => w.what[k]).join(", ");
  const sources = f.sources.map((s) => sourceSpan(lang, s)).join(" ");
  const first = report.timed && f.firstT !== null ? `+${clockText(lang, f.firstT)}` : w.event(f.firstCall);
  return `<tr data-file><td>${levelBadge(lang, f.level)}</td><td class="path">${masked(f.label)}</td><td>${esc(what)}</td><td>${sources}</td><td>${esc(first)}</td><td class="num">${esc(f.calls.toLocaleString(lang))}</td></tr>`;
}

function filesSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const rows: string[] = [];
  let shown = 0;
  let folded = 0;
  for (const f of report.files) {
    if (onlyRead(f) && shown >= READ_ONLY_SHOWN) {
      folded++;
      continue;
    }
    if (onlyRead(f)) shown++;
    rows.push(fileRow(lang, report, f));
  }
  if (folded > 0)
    rows.push(`<tr><td colspan="6" class="note">${esc(w.folded(folded.toLocaleString(lang)))}</td></tr>`);
  if (rows.length === 0) rows.push(`<tr><td colspan="6" class="note">${esc(w.noFile)}</td></tr>`);
  const head = w.fileCols.map((c, i) => `<th${i === 5 ? ' class="num"' : ""}>${esc(c)}</th>`).join("");
  return `<section data-section="files">
<h2>${esc(w.headings.files)}</h2>
<div class="wrap"><table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
</section>`;
}

/** The searches and listings, when the session made any. */
function searchesSection(lang: Lang, report: FilesReport): string {
  if (report.searches.length === 0) return "";
  const w = W[lang];
  const head = w.searchCols.map((c, i) => `<th${i === 5 ? ' class="num"' : ""}>${esc(c)}</th>`).join("");
  const rows = report.searches.map((f) => {
    const first = report.timed && f.firstT !== null ? `+${clockText(lang, f.firstT)}` : w.event(f.firstCall);
    const tools = f.tools.map((t) => code(scrub(t))).join(", ");
    return `<tr data-search><td>${levelBadge(lang, f.level)}</td><td class="path">${masked(f.label)}</td><td>${esc(w.searchWhat[f.what])}</td><td>${tools}</td><td>${esc(first)}</td><td class="num">${esc(f.calls.toLocaleString(lang))}</td></tr>`;
  });
  return `<section data-section="searches">
<h2>${esc(w.headings.searches)}</h2>
<p class="note">${esc(w.searchNote)}</p>
<div class="wrap"><table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
</section>
`;
}

function limitsSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  const anyModel =
    report.findings.some((f) => f.source === "model") ||
    report.files.some((f) => f.sources.includes("model"));
  const items = [
    ...w.limits,
    ...(report.powershell ? [w.limitPowershell] : []),
    ...(anyModel ? [w.limitModel] : []),
  ].map((l) => `<li>${esc(l)}</li>`);
  return `<section data-section="limits">
<h2>${esc(w.headings.limits)}</h2>
<ol class="limits">
${items.join("\n")}
</ol>
</section>`;
}

function methodSection(lang: Lang, report: FilesReport): string {
  const w = W[lang];
  // The method lines are this module's own markup; only the count is inserted.
  const count = esc(report.placeholders.toLocaleString(lang));
  const items = w.method(report.placeholders, count).map((l) => `<li>${l}</li>`);
  return `<section data-section="method">
<h2>${esc(w.headings.method)}</h2>
<ul class="method">
${items.join("\n")}
</ul>
</section>`;
}

// ---- The document ---------------------------------------------------------------

// The brand tokens of the mockup: dark espresso on :root, light paper under
// [data-design="light"]. Colour sits only on the level lines; no shadow.
const CSS = `
:root{
  --bg:#17120D;--bg-raise:#201913;--line:#33291F;--ink:#EDE7DC;--muted:#A2988A;--faint:#5C5142;
  --sp-red:#C05A4C;--sp-amber:#CE9440;--sp-teal:#2DD4A7;--sp-violet:#8B7CF0;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
:root[data-design="light"]{
  --bg:#F6F4EE;--bg-raise:#EFECE3;--line:#DDD8CB;--ink:#17161A;--muted:#6A665D;--faint:#A39E92;
  --sp-red:#C24B3E;--sp-amber:#A9762A;--sp-teal:#0F9D77;--sp-violet:#6C5CE7;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}
.bar{display:flex;justify-content:flex-end;margin-bottom:12px}
.bar button{font:12px var(--mono);background:none;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:3px 9px;cursor:pointer}
.kicker{font:12px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
h1{font-size:26px;font-weight:660;letter-spacing:-.012em;margin:0 0 6px;overflow-wrap:anywhere}
h2{font-size:16px;font-weight:640;margin:30px 0 10px;padding-top:14px;border-top:1px solid var(--line)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;font-size:13px;color:var(--muted);margin:10px 0 0}
.meta dt{font:12px var(--mono)}
.meta dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.verdict{margin-top:22px;border:1px solid var(--line);border-left:6px solid var(--faint);border-radius:10px;background:var(--bg-raise);padding:14px 18px}
.verdict-critical{border-left-color:var(--sp-red)} .verdict-sensitive{border-left-color:var(--sp-amber)}
.verdict-unknown{border-left-color:var(--sp-violet)} .verdict-project{border-left-color:var(--sp-teal)}
.verdict .level{font:12px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
.verdict p{margin:4px 0}
.verdict ul{margin:8px 0 0;padding-left:18px}
.lv{display:inline-block;font:11px var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:0 0 0 8px;border-left:3px solid var(--faint);white-space:nowrap}
.lv-critical{border-color:var(--sp-red)} .lv-sensitive{border-color:var(--sp-amber)} .lv-project{border-color:var(--sp-teal)} .lv-unknown{border-color:var(--sp-violet)}
.src{font:11px var(--mono);color:var(--muted)}
.src-probable{text-decoration:underline dotted;text-underline-offset:3px}
.src-model{text-decoration:underline dashed;text-underline-offset:3px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th{font:11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;font-weight:400;border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
code,.path{font:12.5px var(--mono);overflow-wrap:anywhere}
td code,td.path{overflow-wrap:break-word}
.finding{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--bg-raise)}
.finding header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.finding header b{font-weight:600}
.finding .when{margin-left:auto;font:12px var(--mono);color:var(--muted)}
.finding p{margin:6px 0 0}
.masked{font:12px var(--mono);border:1px solid var(--line);border-bottom-color:var(--sp-red);border-radius:3px;padding:0 4px}
.matrix td,.matrix th{text-align:right}
.matrix td:first-child,.matrix th:first-child{text-align:left}
.note,.none{color:var(--muted);font-size:13px}
pre.cmd{font:12px/1.45 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.cut{color:var(--muted)}
ol.limits li,ul.method li{margin:3px 0}
footer{margin-top:36px;font:12px var(--mono);color:var(--muted)}
@media print{
  :root,:root[data-design]{--bg:#fff;--bg-raise:#fff;--line:#d4d0c6;--ink:#111;--muted:#555;--faint:#999;
    --sp-red:#B23A2E;--sp-amber:#8F6220;--sp-teal:#0C7F60;--sp-violet:#5847C9}
  .bar{display:none}
  td code,td.path{overflow-wrap:anywhere}
  main{max-width:none;padding:0}
  .finding,.verdict,tr{break-inside:avoid}
  h2{break-after:avoid}
  @page{size:A4;margin:16mm 14mm}
}
`;

// The switch only: shown when scripts run, it flips data-design on the root.
const SWITCH = `
(function () {
  var b = document.getElementById("design-switch");
  if (!b) return;
  b.hidden = false;
  b.addEventListener("click", function () {
    var r = document.documentElement;
    r.dataset.design = r.dataset.design === "dark" ? "light" : "dark";
  });
})();
`;

/**
 * The files report as one self-contained HTML document in the report's
 * language: header, verdict, where the content went, findings, files by
 * level, all files, searches and listings (when any), what the report cannot
 * see, method. Light by default,
 * with a switch to dark; print is light.
 */
export function reportHtml(report: FilesReport, lang: Lang): string {
  const w = W[lang];
  const title = report.title ?? scrub(report.sessionId);
  const version = report.version === null ? null : scrub(report.version);
  return `<!doctype html>
<html lang="${lang}" data-design="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.doc)} · ${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="bar"><button type="button" id="design-switch" hidden>${esc(w.switch)}</button></div>
${headerSection(lang, report)}
${verdictSection(lang, report)}
${destinationsSection(lang, report)}
${findingsSection(lang, report)}
${levelsSection(lang, report)}
${filesSection(lang, report)}
${searchesSection(lang, report)}${limitsSection(lang, report)}
${methodSection(lang, report)}
<footer>${esc(w.footer(version))}</footer>
</main>
<script>${SWITCH}</script>
</body>
</html>
`;
}

/** Punctuation that would confuse a file system, folded to single dashes (the rule of export/html.ts). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * `spectroscope-files-report-<slug>-<yyyymmdd-hhmm>.<ext>`, slug and UTC stamp
 * as `exportFilename` in export/html.ts. Pass `report.title`, the title the
 * model masked: a title from outside the report can carry a value only the
 * report knows. Credential shapes are masked here once more.
 */
export function reportFilename(ext: "html" | "csv", title: string | null, now: number): string {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${utcTime(d, false).replace(":", "")}`;
  const name = title === null ? "" : slug(scrub(title));
  return `spectroscope-files-report${name === "" ? "" : `-${name}`}-${stamp}.${ext}`;
}

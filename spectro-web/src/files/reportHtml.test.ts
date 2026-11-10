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
import { reportFilename, reportHtml } from "./reportHtml";

const T0 = 1_760_000_000_000;
const W = "/w";

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
      "It checked for secret files by name, credentials by shape, environment and keychain dumps, " +
        "network commands, files outside the project, personal data and scripts with unknown effect, " +
        "and found none of these.",
    );
    expect(en).not.toMatch(/\bsafe\b/i);
    expect(en).toContain('<p class="none">No finding.</p>');

    const de = reportHtml(project, "de");
    expect(de).toContain(
      "Geprüft wurden geheime Dateien nach Namen, Zugangsdaten nach Form, Ausgaben der Umgebung und " +
        "des Schlüsselbunds, Netzwerkbefehle, Dateien außerhalb des Projekts, personenbezogene Daten " +
        "und Skripte mit unbekannter Wirkung; nichts davon wurde gefunden.",
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

  it("prints times with the files tab's clock and calls by event index", () => {
    const en = reportHtml(report, "en");
    const secret = article(en, "secret-file");
    expect(secret).toContain(`+${clockText("en", 2)} · call 2 · main`);
    const de = reportHtml(report, "de");
    expect(article(de, "secret-file")).toContain(`+${clockText("de", 2)} · Aufruf 2 · main`);
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

  it("says when the workspace was not recorded", () => {
    const rec = new Rec().start(null).tool("read_file", { path: "/etc/hosts" });
    const html = reportHtml(build(rec.events), "en");
    expect(html).toContain("<dt>workspace</dt><dd>not recorded");
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

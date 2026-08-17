// The export is the one surface where a session's text becomes MARKUP, so the
// escaping tests come first and carry the most weight: a transcript is a third
// party's data (shell commands, quotes, angle brackets, sometimes HTML), and an
// exported file is opened by someone who was never in the room.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { chatToHtml, escapeHtml, exportFilename, textFeedToHtml } from "./html";

/** Pinned so the header stamp is deterministic across machines and zones. */
const NOW = Date.UTC(2026, 6, 27, 12, 3, 0);
const ts = Date.UTC(2026, 6, 27, 11, 0, 0);

const SCRIPT = "<script>alert(1)</script>";
const ATTR = '" onerror="alert(2)';

/** A session whose every free-text field carries markup. */
const hostile: RunEvent[] = [
  {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: `find ${SCRIPT} in the logs`,
    provider: "anthropic",
    model: "claude-sonnet-5",
    ts,
  },
  { type: "thinking_delta", agentId: "main", text: `the payload is ${ATTR}`, ts },
  { type: "text_delta", agentId: "main", text: `I found ${SCRIPT} and ${ATTR}.`, ts },
  {
    type: "tool_call",
    agentId: "main",
    callId: "c1",
    name: "run_command",
    input: { cmd: `grep -r "${SCRIPT}" .` },
    ts,
  },
  {
    type: "tool_result",
    agentId: "main",
    callId: "c1",
    output: `app.js:12: ${SCRIPT}\nindex.html:3: <img src=x ${ATTR}>`,
    isError: false,
    durationMs: 42,
    ts,
  },
  { type: "error", agentId: "main", message: `parser choked on ${SCRIPT}`, ts },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
];

/** Every src attribute in the document, in order. */
function srcAttributes(html: string): string[] {
  return [...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]);
}

describe("escapeHtml", () => {
  it("neutralises every character that can open markup or close an attribute", () => {
    expect(escapeHtml(`<a href="x" & 'y'>`)).toBe("&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;");
  });

  it("escapes an ampersand once, never twice", () => {
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves ordinary text byte for byte", () => {
    expect(escapeHtml("grep -rn foo bar/baz.txt")).toBe("grep -rn foo bar/baz.txt");
  });
});

describe.each([
  ["chatToHtml", chatToHtml],
  ["textFeedToHtml", textFeedToHtml],
])("%s — session text is text, never markup", (_name, render) => {
  const html = render(hostile, { label: `session ${SCRIPT}`, now: NOW });

  it("never emits a script tag", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("javascript:");
  });

  it("renders the script payload as visible text", () => {
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("never lets a quote escape an attribute", () => {
    expect(html).not.toContain('" onerror="');
    expect(html).toContain("&quot; onerror=&quot;alert(2)");
  });

  it("escapes the markup inside tool commands and tool output", () => {
    expect(html).toContain("&lt;img src=x &quot; onerror=&quot;alert(2)&gt;");
  });

  it("escapes the label before it reaches the title", () => {
    expect(html).toContain("<title>");
    expect(html).not.toMatch(/<title>[^<]*<script/);
  });
});

describe.each([
  ["chatToHtml", chatToHtml],
  ["textFeedToHtml", textFeedToHtml],
])("%s — one file, no network", (_name, render) => {
  const html = render(hostile, { label: "incident 4712", now: NOW });

  it("is a complete html document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("pulls in nothing: no stylesheet link, no import, no url()", () => {
    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("url(");
  });

  it("carries its own style block", () => {
    expect(html).toContain("<style>");
    expect(html).toContain("--bg: #17120d"); // the espresso ground, inlined
  });

  it("has no src that leaves the file", () => {
    for (const src of srcAttributes(html)) expect(src.startsWith("data:")).toBe(true);
  });

  it("carries the header: label, export time, event count", () => {
    expect(html).toContain("incident 4712");
    expect(html).toContain("2026-07-27 12:03 UTC");
    expect(html).toContain(`${hostile.length} events`);
  });

  it("renders the same bytes for the same input", () => {
    expect(render(hostile, { label: "incident 4712", now: NOW })).toBe(html);
  });

  it("still produces a document for an empty session", () => {
    const empty = render([], { now: NOW });
    expect(empty.startsWith("<!doctype html>")).toBe(true);
    expect(empty).toContain("0 events");
  });
});

describe("a payload aimed at the exporter's own containers", () => {
  // The real attack on a template-string renderer is not <script> in a
  // paragraph — it is text that closes the element it was placed inside.
  const breakout = [
    "</style><style>body{display:none}",
    "</pre></details><script>alert(3)</script>",
    "</title></head><body>",
    "]]></div>",
  ].join("\n");

  const events: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: breakout, ts },
    { type: "text_delta", agentId: "main", text: "```" + breakout + "\n" + breakout + "\n```", ts },
    { type: "tool_call", agentId: "main", callId: "c1", name: breakout, input: { x: breakout }, ts },
    {
      type: "tool_result",
      agentId: "main",
      callId: "c1",
      output: breakout,
      isError: true,
      durationMs: 1,
      ts,
    },
  ];

  it.each([
    ["chatToHtml", chatToHtml],
    ["textFeedToHtml", textFeedToHtml],
  ])("%s closes nothing it did not open", (_name, render) => {
    const html = render(events, { label: breakout, now: NOW });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</title></head>");
    // Exactly the containers this document opens — the payload adds none.
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<body>/g)).toHaveLength(1);
    expect(html.match(/<\/title>/g)).toHaveLength(1);
    expect(html).toContain("&lt;/style&gt;&lt;style&gt;");
  });

  it("escapes a hostile fence language before printing it", () => {
    const html = chatToHtml(
      [{ type: "text_delta", agentId: "main", text: "```<img/onerror=x>\nbody\n```", ts }],
      { now: NOW },
    );
    expect(html).toContain("&lt;img/onerror=x&gt;");
    expect(html).not.toContain("<img/onerror=x>");
  });

  it("escapes hostile markdown table cells", () => {
    const table = '| a | b |\n| --- | --- |\n| <script>x</script> | `" onerror="` |';
    const html = chatToHtml([{ type: "text_delta", agentId: "main", text: table, ts }], { now: NOW });
    expect(html).toContain("<td>&lt;script&gt;x&lt;/script&gt;</td>");
    expect(html).not.toContain('" onerror="');
  });
});

describe("chatToHtml — the conversation", () => {
  it("shows the prompt, the answer and the tool call with its result", () => {
    const html = chatToHtml(hostile, { now: NOW });
    expect(html).toContain("find &lt;script&gt;");
    expect(html).toContain("I found &lt;script&gt;");
    expect(html).toContain("run_command");
    expect(html).toContain("app.js:12:");
    expect(html).toContain("parser choked on");
  });

  it("renders the answer as markdown, through the app's parser", () => {
    const events: RunEvent[] = [
      { type: "text_delta", agentId: "main", text: "## Result\n\n- **one**\n- two\n", ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>one</strong>");
    expect(html).toContain("<li>two</li>");
  });

  it("colours a fenced code block with the app's tokenizer", () => {
    const events: RunEvent[] = [
      { type: "text_delta", agentId: "main", text: "```bash\ngrep -r x .\n```\n", ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain('<span class="hl hl-keyword">grep</span>');
  });

  it("keeps a vetted link and defuses a javascript: one (the parser refuses it)", () => {
    const events: RunEvent[] = [
      {
        type: "text_delta",
        agentId: "main",
        text: "see [docs](https://spectroscope.dev/?a=1&b=2) and [bad](javascript:alert(1))",
        ts,
      },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain('href="https://spectroscope.dev/?a=1&amp;b=2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
  });

  it("shows the gate decision on a denied call and never prints an output for it", () => {
    const events: RunEvent[] = [
      { type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "/etc" }, ts },
      { type: "permission_request", agentId: "main", callId: "c1", name: "write_file", input: {}, ts },
      { type: "permission_decision", callId: "c1", allowed: false, ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("denied");
    expect(html).toContain("write_file");
  });

  it("nests a subagent's turns under its own badge", () => {
    const events: RunEvent[] = [
      { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "review the diff", ts },
      { type: "text_delta", agentId: "worker-1", text: "looks fine", ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("worker-1");
    expect(html).toContain("review the diff");
    expect(html).toContain("looks fine");
  });

  it("escapes the footer too — the stop reason comes off the wire", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", provider: "<b>x</b>", ts },
      { type: "run_end", runId: "r1", stopReason: "<b>done</b>", ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("&lt;b&gt;done&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("names no tokens when the run measured none", () => {
    const events: RunEvent[] = [{ type: "text_delta", agentId: "main", text: "ok", ts }];
    expect(chatToHtml(events, { now: NOW })).not.toContain("0 in · 0 out");
  });

  it("prints the answer meta line when the run reported usage", () => {
    const events: RunEvent[] = [
      { type: "text_delta", agentId: "main", text: "ok", ts },
      { type: "usage", agentId: "main", inputTokens: 79, outputTokens: 5, ts: ts + 500 },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("79 in");
    expect(html).toContain("5 out");
  });
});

describe("chatToHtml — a tool input is text, not one escaped line", () => {
  const script =
    "export const meta = {\n  name: 'gate',\n};\n\nexport default async function run() {\n  return 1;\n}\n";
  const events: RunEvent[] = [
    {
      type: "tool_call",
      agentId: "main",
      callId: "c1",
      name: "Workflow",
      input: { name: "gate", script },
      ts,
    },
    { type: "tool_result", agentId: "main", callId: "c1", output: "ok", isError: false, durationMs: 3, ts },
  ];
  const html = chatToHtml(events, { now: NOW });

  it("prints the body with real breaks, never as the escape that stood for one", () => {
    expect(html).toContain("meta = {\n  name: ");
    expect(html).not.toContain("\\n");
  });

  // A Workflow now arrives as a workflow (toolBody.ts), so the shape-plus-blocks
  // split is what a tool NOBODY named a shape for gets — which is where it was
  // always the right answer. Same two guarantees, asserted where they still hold.
  const unshaped = chatToHtml(
    [{ type: "tool_call", agentId: "main", callId: "c1", name: "odd_tool", input: { script }, ts }],
    { now: NOW },
  );

  it("labels the lifted field with the payload's own word", () => {
    expect(unshaped).toContain(`<div class="x-io">script</div>`);
  });

  it("leaves the reference behind in the shape, so nothing reads as dropped", () => {
    expect(unshaped).toContain("(7 lines below)");
  });

  it("colours the script with the tokenizer the app uses", () => {
    expect(html).toContain('<span class="hl hl-keyword">export</span>');
  });

  it("summarises the call in the fold line, without the body", () => {
    const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
    expect(summary).toContain("name: gate");
    expect(summary).toContain("script: 7 lines");
    expect(summary).not.toContain("export const meta");
  });

  it("resolves every highlight class inside the file itself", () => {
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const used = new Set([...html.matchAll(/class="hl hl-([a-z]+)"/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const cls of used) expect(css).toContain(`.hl-${cls}{`);
  });

  it("escapes a hostile field name before it becomes a label", () => {
    const hostileKey = chatToHtml(
      [
        {
          type: "tool_call",
          agentId: "main",
          callId: "c1",
          name: "X",
          input: { "</pre><script>alert(4)</script>": "a\nb" },
          ts,
        },
      ],
      { now: NOW },
    );
    expect(hostileKey).not.toContain("<script");
    expect(hostileKey).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  it("still colours a shell command it was handed under a plain key", () => {
    const shell = chatToHtml(
      [
        {
          type: "tool_call",
          agentId: "main",
          callId: "c1",
          name: "run_command",
          input: { command: "grep -r x .\ngrep -r y ." },
          ts,
        },
      ],
      { now: NOW },
    );
    expect(shell).toContain('<span class="hl hl-keyword">grep</span>');
  });

  it("renders a body whose language nothing names byte for byte, uncoloured", () => {
    const plain = chatToHtml(
      [
        {
          type: "tool_call",
          agentId: "main",
          callId: "c1",
          name: "Write",
          input: { path: "notes.txt", content: "# Title\n\n1999 was a year.\n" },
          ts,
        },
      ],
      { now: NOW },
    );
    expect(plain).toContain("# Title\n\n1999 was a year.");
    expect(plain).not.toContain('class="hl hl-number">1999');
  });
});

describe("textFeedToHtml — the feed", () => {
  it("shows the protocol markers as readable text", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", provider: "ollama", ts },
      { type: "thinking_delta", agentId: "main", text: "hmm", ts },
      { type: "text_delta", agentId: "main", text: "hello", ts },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
    ];
    const html = textFeedToHtml(events, { now: NOW });
    expect(html).toContain("&lt;think&gt;");
    expect(html).toContain("&lt;/think&gt;");
    expect(html).toContain("[run_start ollama]");
    expect(html).toContain("[run_end end_turn]");
    expect(html).toContain("hello");
  });

  it("prefixes a subagent's block with its id, like the tab does", () => {
    const events: RunEvent[] = [{ type: "text_delta", agentId: "worker-1", text: "done", ts }];
    expect(textFeedToHtml(events, { now: NOW })).toContain("[worker-1]");
  });

  it("adds the extended frames only when asked", () => {
    const events: RunEvent[] = [{ type: "usage", agentId: "main", inputTokens: 10, outputTokens: 2, ts }];
    expect(textFeedToHtml(events, { now: NOW })).not.toContain("[usage 10 in");
    expect(textFeedToHtml(events, { now: NOW, extended: true })).toContain("[usage 10 in · 2 out]");
  });
});

describe("the provenance note", () => {
  it("prints what the orchestrator hands it, escaped", () => {
    const html = chatToHtml(hostile, { now: NOW, note: `translated to de <b>` });
    expect(html).toContain("translated to de &lt;b&gt;");
  });

  it("prints no note element when there is nothing to say", () => {
    expect(chatToHtml(hostile, { now: NOW })).not.toContain('<p class="x-note">');
  });
});

describe("exportFilename", () => {
  it("names the file after the view, the session and the moment", () => {
    expect(exportFilename("chat", "Incident 4712", NOW)).toBe(
      "spectroscope-chat-incident-4712-20260727-1203.html",
    );
  });

  it("survives a label made of punctuation", () => {
    expect(exportFilename("text", "../../etc/passwd <script>", NOW)).toBe(
      "spectroscope-text-etc-passwd-script-20260727-1203.html",
    );
  });

  it("falls back to the plain name when there is no label", () => {
    expect(exportFilename("chat", undefined, NOW)).toBe("spectroscope-chat-20260727-1203.html");
  });
});

// Card 179, adversarial pass. The user bubble has rendered its attachments as
// data: URIs since the file was written; a tool card never did — and 83% of the
// imported pictures sit on a card. Two of the heaviest files exported a
// document that looks like the app and holds none of their pictures.
describe("pictures a tool handed back, in the exported file", () => {
  const T0 = 1700000000000;
  const png = "iVBORw0KGgoAAAANSUhEUg==";
  const events = [
    { type: "run_start", runId: "r", agentId: "main", prompt: "shoot it", ts: T0 },
    { type: "tool_call", agentId: "main", callId: "t1", name: "screenshot", input: {}, ts: T0 },
    {
      type: "attachment_image",
      agentId: "main",
      callId: "t1",
      mediaType: "image/png",
      dataBase64: png,
      note: "[image/png · 18 B]",
      ts: T0,
    },
    { type: "tool_result", agentId: "main", callId: "t1", output: "ok", ts: T0 + 1 },
    { type: "run_end", runId: "r", agentId: "main", reason: "completed", ts: T0 + 2 },
  ] as unknown as RunEvent[];

  it("carries the bytes into the document", () => {
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain(`data:image/png;base64,${png}`);
  });

  it("names it, so a reader knows what he is looking at", () => {
    expect(chatToHtml(events, { now: NOW })).toContain("[image/png · 18 B]");
  });
});

// Card 264, AC 3: this footer is a reader that switches on stopReason, and it
// is indifferent by construction — it prints the reason the record carries.
// Pinned anyway, because "indifferent" is a claim about behaviour and the
// verdict is only worth having if it survives into the file somebody archives.
describe("an abandoned run in the exported document", () => {
  const T0 = 1700000000000;
  const events: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "fix the bug", provider: "lmstudio", ts: T0 },
    {
      type: "plan",
      agentId: "main",
      steps: [
        { text: "write the failing test", status: "completed" },
        { text: "make it pass", status: "pending" },
      ],
      ts: T0 + 1,
    },
    { type: "text_delta", agentId: "main", text: "I wrote the test.", ts: T0 + 2 },
    { type: "run_end", runId: "r1", stopReason: "unfinished", ts: T0 + 3 },
  ];

  it("names the verdict instead of the clean finish it never was", () => {
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("ended: unfinished");
  });

  it("says it in German too", () => {
    expect(chatToHtml(events, { now: NOW, lang: "de" })).toContain("beendet: unfinished");
  });

  // Fix pass: verbatim was not enough. The archived file is read by somebody who
  // was not there, and "unfinished" without a count says less than the Plan panel
  // sitting in the same document — while an ungradable run said nothing at all.
  it("says how much was left open, in both languages", () => {
    expect(chatToHtml(events, { now: NOW })).toContain("ended: unfinished · 1 of 2 steps open");
    expect(chatToHtml(events, { now: NOW, lang: "de" })).toContain(
      "beendet: unfinished · 1 von 2 Schritten offen",
    );
  });

  it("marks the run nobody can grade as exactly that", () => {
    const noPlan: RunEvent[] = [
      {
        type: "run_start",
        runId: "r1",
        agentId: "main",
        prompt: "fix the bug",
        provider: "lmstudio",
        ts: T0,
      },
      { type: "text_delta", agentId: "main", text: "Done, I think.", ts: T0 + 1 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T0 + 2 },
    ];
    expect(chatToHtml(noPlan, { now: NOW })).toContain("ended: end_turn · no plan on record");
    expect(chatToHtml(noPlan, { now: NOW, lang: "de" })).toContain(
      "beendet: end_turn · kein Plan aufgezeichnet",
    );
  });

  it("stays silent where the reason and the ledger agree", () => {
    const finished: RunEvent[] = [
      {
        type: "run_start",
        runId: "r1",
        agentId: "main",
        prompt: "fix the bug",
        provider: "lmstudio",
        ts: T0,
      },
      {
        type: "plan",
        agentId: "main",
        steps: [
          { text: "write the failing test", status: "completed" },
          { text: "make it pass", status: "completed" },
        ],
        ts: T0 + 1,
      },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T0 + 2 },
    ];
    const html = chatToHtml(finished, { now: NOW });
    expect(html).toContain("ended: end_turn");
    expect(html).not.toContain("steps open");
    expect(html).not.toContain("no plan on record");
  });
});

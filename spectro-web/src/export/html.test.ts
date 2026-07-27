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

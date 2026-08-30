// A tool call in an exported file is the same THING it is in the app: a file
// being read, a command in a terminal, an edit with two sides. The app learned
// that with card 94 (describeTool + ToolViewBody); the export had only learned
// half of it, lifting long fields out of the JSON while still drawing every call
// as its JSON shape.
//
// These tests go through chatToHtml rather than through the writers directly:
// what matters is what lands in the file someone opens, and the path from a
// RunEvent to that markup runs through the reducer and the card.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { chatToHtml } from "./html";

const NOW = Date.UTC(2026, 6, 27, 12, 3, 0);
const ts = Date.UTC(2026, 6, 27, 11, 0, 0);

/** One tool call and its result, rendered, cut down to the card itself. */
function card(name: string, input: unknown, output?: string, isError = false, fileChange?: string): string {
  const events: RunEvent[] = [{ type: "tool_call", agentId: "main", callId: "c1", name, input, ts }];
  if (output !== undefined) {
    events.push({
      type: "tool_result",
      agentId: "main",
      callId: "c1",
      output,
      isError,
      durationMs: 3,
      fileChange,
      ts,
    });
  }
  const html = chatToHtml(events, { now: NOW });
  const from = html.indexOf('<details class="x-tool"');
  return html.slice(from, html.indexOf("</details>", from));
}

/** Everything below the summary row — the summary is a teaser and keeps its own
 *  shape, so an assertion about the BODY must not be satisfied by the fold line. */
const body = (html: string): string => html.slice(html.indexOf("</summary>"));

describe("a read is a file, not a json shape", () => {
  // The owner's own screenshot: `read_file auth.ts` came out as INPUT
  // { "path": "auth.ts" } over OUTPUT line one / line two.
  const html = card("read_file", { path: "auth.ts" }, "line one\nline two");

  it("names the file once, as a path", () => {
    expect(body(html)).toContain('<div class="x-tv-path">auth.ts</div>');
  });

  it("does not print the input as its json shape", () => {
    expect(body(html)).not.toContain("&quot;path&quot;");
  });

  it("counts the lines it read", () => {
    expect(body(html)).toContain("2 lines");
  });

  it("prints the body under its own word, not under `output`", () => {
    expect(body(html)).toContain("line one\nline two");
    expect(body(html)).toContain('<div class="x-io">content');
  });

  it("colours the body by the file's own name", () => {
    const ts_ = card("Read", { path: "auth.ts" }, "const token = 1;\n");
    expect(body(ts_)).toContain('<span class="hl hl-keyword">const</span>');
  });
});

describe("a command is a command", () => {
  const html = body(card("Bash", { command: "npm run gate" }, "12 passed"));

  it("prints it at a prompt, coloured as shell", () => {
    expect(html).toContain('<span class="x-tv-prompt"');
    expect(html).toContain('<span class="hl hl-keyword">npm</span>');
  });

  it("puts the result in a terminal well", () => {
    expect(html).toContain("x-tv-term");
    expect(html).toContain("12 passed");
  });

  it("marks a failed run", () => {
    expect(body(card("run_command", { command: "false" }, "boom", true))).toContain("x-tv-term--failed");
  });
});

describe("an edit has two sides", () => {
  const html = body(
    card(
      "Edit",
      { path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      "1 replacement",
    ),
  );

  it("shows before and after next to each other", () => {
    expect(html).toContain("x-tv-side--before");
    expect(html).toContain("x-tv-side--after");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("const a = 2;");
  });

  it("names the file it edited", () => {
    expect(html).toContain('<div class="x-tv-path">src/app.ts</div>');
  });
});

describe("the line-shaped results are lines", () => {
  it("draws a listing as rows and marks the directories", () => {
    const html = body(card("list_dir", { path: "src" }, "app.ts\nstyles/\n"));
    expect(html).toContain('<li class="x-tv-item">app.ts</li>');
    expect(html).toContain('<li class="x-tv-item x-tv-item--dir">styles/</li>');
    expect(html).toContain("2 entries");
  });

  it("draws matches under their pattern", () => {
    const html = body(card("Grep", { pattern: "TODO", path: "src" }, "src/a.ts:3: TODO\n"));
    expect(html).toContain('<span class="x-tv-pattern">TODO</span>');
    expect(html).toContain("1 hits");
    expect(html).toContain("src/a.ts:3: TODO");
  });
});

describe("the shapes that are not files", () => {
  it("draws a write with the body it was about to put on disk", () => {
    const html = body(card("write_file", { path: "notes.md", content: "# Title\n\nbody\n" }, "wrote"));
    expect(html).toContain('<div class="x-io">wrote');
    expect(html).toContain("# Title\n\nbody");
  });

  // Card 269. The word goes to both renderers or to neither (html.ts says so in
  // its own comment): a saved file that dropped the news that the run keeps
  // writing the same bytes would be a second, kinder reading of the same call.
  it("says in the file too that the write changed nothing", () => {
    const html = body(
      card(
        "write_file",
        { path: "src/particleEngine.js", content: "x\n" },
        "Wrote: src/particleEngine.js (2 bytes) — unchanged (the file already contained exactly these bytes)",
        false,
        "unchanged",
      ),
    );
    expect(html).toContain('class="x-tv-note x-tv-change x-tv-change--unchanged"');
    expect(html).toContain(">unchanged</p>");
  });

  it("claims nothing in the file when the record claimed nothing", () => {
    const html = body(card("write_file", { path: "a.js", content: "x\n" }, "Wrote: a.js (2 bytes)"));
    expect(html).not.toContain("x-tv-change");
  });

  it("draws a fan-out as one block per child", () => {
    const html = body(
      card("spawn_agents", { agents: [{ type: "reviewer", task: "read the diff" }] }, "done"),
    );
    expect(html).toContain('<span class="x-tv-agent-type">reviewer</span>');
    expect(html).toContain("read the diff");
    expect(html).toContain("1 agents");
  });

  it("draws a plan as steps carrying the status the plan wrote", () => {
    const html = body(card("TodoWrite", { todos: [{ content: "ship it", status: "in_progress" }] }, "ok"));
    expect(html).toContain('<span class="x-tv-step-text">ship it</span>');
    expect(html).toContain('<span class="x-tv-status">in_progress</span>');
  });

  it("draws a created task as its subject over its description, under the id the result gave", () => {
    const html = body(
      card(
        "TaskCreate",
        {
          subject: "Reproduce stop bug against :8098 (timebox 60min, wire-first)",
          description:
            "Node WS script against ws://localhost:8098/ws: long-reasoning prompt, abort mid-stream.",
          activeForm: "Reproducing stop bug against :8098",
        },
        "Task #2 created successfully: Reproduce stop bug against :8098 (timebox 60min, wire-first)",
      ),
    );
    expect(html).toContain('<div class="x-io">task created');
    expect(html).toContain('<span class="x-tv-task-id">#2</span>');
    expect(html).toContain("Reproduce stop bug against :8098");
    expect(html).toContain("Node WS script against ws://localhost:8098/ws");
    // The present-tense phrasing is the same fact in a shorter tense, so it is
    // not drawn a second time under the subject it paraphrases.
    expect(html).not.toContain("Reproducing stop bug");
    // The outcome line named the id and echoed the subject; both are above, so
    // it is not reprinted as an output underneath.
    expect(html).not.toContain("created successfully");
  });

  it("draws a status update as the task and the state, with no invented text", () => {
    const html = body(card("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status"));
    expect(html).toContain('<div class="x-io">task updated');
    expect(html).toContain('<span class="x-tv-task-id">#1</span>');
    expect(html).toContain('<span class="x-tv-status">completed</span>');
    expect(html).not.toContain("x-tv-task-subject");
  });

  it("says when the result confirmed the update and named no field", () => {
    const html = body(card("TaskUpdate", { taskId: "9", status: "completed" }, "Updated task #9 "));
    expect(html).toContain("nothing moved");
  });

  it("draws a roster as one row per task, counted", () => {
    const html = body(
      card("TaskList", {}, "#1 [completed] Brand tokens\n#2 [in_progress] Logo set and favicon\n"),
    );
    expect(html).toContain("2 tasks");
    expect(html).toContain('<span class="x-tv-task-id">#2</span>');
    expect(html).toContain("Logo set and favicon");
  });

  it("keeps a task result it could not read, rather than dropping it", () => {
    const html = body(card("TaskUpdate", { taskId: "44", status: "completed" }, "No task #44.", true));
    expect(html).toContain("No task #44.");
  });

  it("draws a question with its options and marks the one that was picked", () => {
    const html = body(
      card(
        "AskUserQuestion",
        { questions: [{ question: "deploy?", options: [{ label: "yes" }, { label: "no" }] }] },
        'The user answered: "deploy?"="yes". Proceed.',
      ),
    );
    expect(html).toContain("deploy?");
    expect(html).toContain("x-tv-opt--chosen");
    expect(html).toContain("yes");
  });

  it("says so when a question was left hanging", () => {
    const html = body(
      card("AskUserQuestion", {
        questions: [{ question: "deploy?", options: [{ label: "yes" }] }],
      }),
    );
    expect(html).toContain("not answered");
  });

  it("draws a skill by its name", () => {
    const html = body(card("Skill", { name: "humanizer" }, "loaded"));
    expect(html).toContain('<div class="x-tv-path">humanizer</div>');
  });

  it("draws an mcp call as server and tool, and keeps the payload unread", () => {
    const html = body(card("mcp__ccd_session__mark_chapter", { title: "red" }, "ok"));
    expect(html).toContain('<span class="x-tv-server">ccd_session</span>');
    expect(html).toContain('<span class="x-tv-pattern">mark_chapter</span>');
    expect(html).toContain("&quot;title&quot;");
  });

  it("draws a fetch by its url", () => {
    const html = body(card("WebFetch", { url: "https://example.org/a" }, "the page"));
    expect(html).toContain('<div class="x-tv-path">https://example.org/a</div>');
    expect(html).toContain("the page");
  });

  it("draws a workflow as its header, its phases and its script", () => {
    const script = "export const meta = {\n  name: 'gate',\n  phases: ['red', 'green'],\n};\n";
    const html = body(card("Workflow", { script }, "ok"));
    expect(html).toContain('<div class="x-tv-path">gate</div>');
    expect(html).toContain("2 phases");
    expect(html).toContain('<span class="hl hl-keyword">export</span>');
  });

  // Card 322 threaded the launch `args` into the export beside the screen, and
  // the region it added was drawn by nothing that could go red: `argsHtml`
  // could be neutered to `return ""` — call site or body — with the whole suite
  // green. `html.ts` states the rule these three hold to: a saved file that
  // showed one reading while the screen beside it showed another would be two
  // readings of one call.

  it("draws a JSON args payload as JSON, one key per line", () => {
    const args = JSON.stringify({ repo: "/tmp/demo-repo", shards: 7, dry: true });
    const html = body(card("Workflow", { scriptPath: "/tmp/wf/x.js", args }, "ok"));

    expect(html).toContain('<div class="x-io">arguments</div>');
    // Coloured, and coloured by parts — a string as a string, a number as a
    // number, `true` as a keyword.
    expect(html).toContain('<span class="hl hl-string">&quot;repo&quot;</span>');
    expect(html).toContain('<span class="hl hl-number">7</span>');
    expect(html).toContain('<span class="hl hl-keyword">true</span>');
    // Re-printed, not the doubly-escaped one-liner the call carried.
    expect(html).not.toContain("\\&quot;");
  });

  it("draws an args payload that is not JSON as the prose it is", () => {
    const prose = 'Rebuild every shard under "shards/", then prove it.\nDelete nothing.';
    const html = body(card("Workflow", { scriptPath: "/tmp/wf/x.js", args: prose }, "ok"));

    expect(html).toContain('<div class="x-io">arguments</div>');
    // The prose well, not the code well — and its own quotes intact, which is
    // what a half-unescaping renderer eats.
    expect(html).toContain("x-tv-prose");
    expect(html).toContain("under &quot;shards/&quot;");
    expect(html).not.toContain("\\n");
  });

  it("draws an args bag that arrived as an object the way an input is drawn", () => {
    const html = body(card("Workflow", { scriptPath: "/tmp/wf/x.js", args: { repo: "/tmp/demo" } }, "ok"));

    expect(html).toContain('<div class="x-io">arguments</div>');
    expect(html).toContain("/tmp/demo");
  });

  it("says an image is not in the file rather than pointing at a fetch", () => {
    const html = body(
      card("generate_image", { prompt: "a cat" }, "Image generated with gemini: /demo/cat.png (1024x1024)"),
    );
    expect(html).toContain("a cat");
    expect(html).toContain("/demo/cat.png");
    expect(html).not.toContain("<img");
    expect(html).toContain("image store");
  });
});

describe("a shape the export does not know stays the raw pair", () => {
  const html = body(card("weird_tool", { x: 1, note: "a\nb" }, "ok"));

  it("prints the input as its shape, coloured as json", () => {
    expect(html).toContain('<span class="hl hl-string">&quot;x&quot;</span>');
    expect(html).toContain('<span class="hl hl-number">1</span>');
  });

  it("still lifts a multi-line field out of the json", () => {
    expect(html).toContain('<div class="x-io">note</div>');
    expect(html).toContain("(2 lines below)");
  });

  it("prints the output", () => {
    expect(html).toContain("ok");
  });
});

describe("the record stays complete", () => {
  it("never clips a body the way the app does — there is no second face here", () => {
    const long = `${"x".repeat(6000)}\n`;
    const html = body(card("read_file", { path: "big.txt" }, long));
    expect(html).toContain("x".repeat(6000));
    expect(html).not.toContain("(truncated)");
  });

  it("prints no result for a denied call, whatever shape it has", () => {
    const events: RunEvent[] = [
      { type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "/etc/x" }, ts },
      { type: "permission_request", agentId: "main", callId: "c1", name: "write_file", input: {}, ts },
      { type: "permission_decision", callId: "c1", allowed: false, ts },
    ];
    const html = chatToHtml(events, { now: NOW });
    expect(html).toContain("denied");
    expect(html).toContain("/etc/x");
  });

  it("escapes a path, a command and an option label like any other text", () => {
    const hostile = '"><script>alert(1)</script>';
    for (const html of [
      card("read_file", { path: hostile }, "x"),
      card("Bash", { command: hostile }, "x"),
      card("list_dir", { path: "src" }, hostile),
    ]) {
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;");
    }
  });
});

describe("a workflow that ran", () => {
  const script =
    "export const meta = {\n  name: 'lab-repair',\n  phases: [{ title: 'Fix' }, { title: 'Verify' }],\n};\n";

  const RECEIPT = "Workflow launched in background. Task ID: w82qt1zg0";

  /** The receipt with the outcome the importer flattened under it. */
  const joined = (failures?: string): string =>
    [
      RECEIPT,
      "",
      "--- task w7cocjg6h · completed ---",
      "summary: Dynamic workflow completed",
      "result: the finding",
      ...(failures === undefined ? [] : [`failures: ${failures}`]),
      "usage: agent_count=3 agents_done=1 agents_error=2 subagent_tokens=604733 " +
        "tool_uses=313 duration_ms=3801742",
    ].join("\n");

  it("says a launch the transcript outlived is still open", () => {
    const out = `${RECEIPT}\n\n--- task w82qt1zg0 · no result by the end of the transcript ---`;
    const html = body(card("Workflow", { script }, out));
    expect(html).toContain("no outcome");
    expect(html).not.toContain("x-tv-run");
  });

  it("draws the outcome as a row of numbers in the app's own formats", () => {
    const html = body(card("Workflow", { script }, joined()));
    expect(html).toContain("1 / 3");
    expect(html).toContain("605k");
    expect(html).toContain("1 h 3 m");
    expect(html).toContain("313");
  });

  it("names the dead agents instead of hiding them behind the summary", () => {
    const html = body(card("Workflow", { script }, joined("[verify] failed: monthly spend limit")));
    // The count is loud in the row AND the agent is named in a region of its own.
    expect(html).toContain("x-tv-run-bad");
    expect(html).toContain("x-tv-fail");
    expect(html).toContain("monthly spend limit");
    // And the phase its label points at, so a reader sees where it died — in
    // the failure row AND on the phase itself, which is the ladder of the run.
    expect(html).toContain("x-tv-fail-why");
    expect(html).toContain('<li class="x-tv-item">Verify <span class="x-tv-dead">· 1 failed</span></li>');
    expect(html).toContain('<li class="x-tv-item">Fix</li>');
  });

  it("keeps the receipt and the returned result apart", () => {
    const html = body(card("Workflow", { script }, joined()));
    expect(html).toContain("Task ID: w82qt1zg0");
    expect(html).toContain("the finding");
    // The section itself is consumed, not reprinted under the receipt.
    expect(html).not.toContain("--- task");
  });
});

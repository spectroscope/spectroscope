// The structured tool view (card 94): each tool call is described as the SHAPE
// it really is — a file read, an edit, a listing, a command — so the card can
// render it as itself instead of as two JSON blobs. Pure, DOM-free.

import { describe, expect, it } from "vitest";
import { describeTool, runStats, splitInput } from "./toolViews";

describe("describeTool — files", () => {
  it("read_file becomes a file view with its path and body", () => {
    const v = describeTool("read_file", { path: "src/App.tsx" }, "line one\nline two", false);
    expect(v.kind).toBe("file");
    if (v.kind !== "file") throw new Error("kind");
    expect(v.path).toBe("src/App.tsx");
    expect(v.body).toBe("line one\nline two");
    expect(v.lineCount).toBe(2);
  });

  it("read_file with offset/limit names the range", () => {
    const v = describeTool("read_file", { path: "a.txt", offset: 10, limit: 5 }, "x", false);
    if (v.kind !== "file") throw new Error("kind");
    expect(v.range).toBe("lines 10–14");
  });

  it("write_file becomes a write view carrying the written content", () => {
    const v = describeTool(
      "write_file",
      { path: "pi.py", content: "import math\nprint(math.pi)" },
      "Wrote: pi.py (26 bytes)",
      false,
    );
    expect(v.kind).toBe("write");
    if (v.kind !== "write") throw new Error("kind");
    expect(v.path).toBe("pi.py");
    expect(v.content).toContain("import math");
    expect(v.result).toBe("Wrote: pi.py (26 bytes)");
  });

  it("edit_file becomes a two-sided edit view", () => {
    const v = describeTool(
      "edit_file",
      { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      "Edited a.ts",
      false,
    );
    expect(v.kind).toBe("edit");
    if (v.kind !== "edit") throw new Error("kind");
    expect(v.before).toBe("const a = 1;");
    expect(v.after).toBe("const a = 2;");
  });
});

describe("describeTool — listings and searches", () => {
  it("list_dir splits its output into entries", () => {
    const v = describeTool("list_dir", { path: "." }, "a.py\nb.py\nsub/", false);
    expect(v.kind).toBe("listing");
    if (v.kind !== "listing") throw new Error("kind");
    expect(v.entries).toEqual(["a.py", "b.py", "sub/"]);
    expect(v.path).toBe(".");
  });

  it("grep keeps its pattern and match lines", () => {
    const v = describeTool("grep", { pattern: "TODO", path: "src" }, "src/a.ts:3:// TODO\n", false);
    expect(v.kind).toBe("matches");
    if (v.kind !== "matches") throw new Error("kind");
    expect(v.pattern).toBe("TODO");
    expect(v.lines).toEqual(["src/a.ts:3:// TODO"]);
  });

  it("glob is a match view too", () => {
    const v = describeTool("glob", { pattern: "**/*.py" }, "a.py\nb.py", false);
    expect(v.kind).toBe("matches");
  });
});

describe("describeTool — commands", () => {
  it("run_command becomes a terminal view", () => {
    const v = describeTool("run_command", { command: "ls -la" }, "total 8\n.\n..", false);
    expect(v.kind).toBe("command");
    if (v.kind !== "command") throw new Error("kind");
    expect(v.command).toBe("ls -la");
    expect(v.output).toContain("total 8");
    expect(v.failed).toBe(false);
  });

  it("an errored command is flagged, not hidden", () => {
    const v = describeTool("run_command", { command: "false" }, "ERROR: exit 1", true);
    if (v.kind !== "command") throw new Error("kind");
    expect(v.failed).toBe(true);
  });
});

describe("describeTool — the honest fallbacks", () => {
  it("an unknown tool falls back to generic, never guesses", () => {
    const v = describeTool("notes_search", { q: "x" }, "hit", false);
    expect(v.kind).toBe("generic");
  });

  it("a known tool with an unexpected input shape falls back to generic", () => {
    // The model can send anything; a missing path must not render an empty card.
    const v = describeTool("read_file", { wrong: true }, "out", false);
    expect(v.kind).toBe("generic");
  });

  it("a pending call (no output yet) still describes its call side", () => {
    const v = describeTool("read_file", { path: "a.txt" }, undefined, false);
    if (v.kind !== "file") throw new Error("kind");
    expect(v.path).toBe("a.txt");
    expect(v.body).toBe("");
  });
});

describe("VS Code agent-mode tool names", () => {
  // An imported VS Code export speaks its own vocabulary and its own field
  // names. Without these the cards fall back to pretty-printed JSON, which is
  // how a shell command ends up rendered as escaped quotes.
  it("reads run_in_terminal as a command", () => {
    const v = describeTool(
      "run_in_terminal",
      { command: "ls -la", explanation: "look", goal: "check", mode: "sync", timeout: 15000 },
      "",
      false,
    );
    expect(v.kind).toBe("command");
    if (v.kind === "command") expect(v.command).toBe("ls -la");
  });

  it("reads create_file as a write, taking the path from filePath", () => {
    const v = describeTool("create_file", { filePath: "/tmp/x.sh", content: "#!/bin/sh\n" }, "", false);
    expect(v.kind).toBe("write");
    if (v.kind === "write") {
      expect(v.path).toBe("/tmp/x.sh");
      expect(v.content).toBe("#!/bin/sh\n");
    }
  });

  it("reads replace_string_in_file as an edit", () => {
    const v = describeTool(
      "replace_string_in_file",
      { filePath: "a.txt", oldString: "one", newString: "two" },
      "",
      false,
    );
    expect(v.kind).toBe("edit");
  });

  it("reads read_file with filePath", () => {
    const v = describeTool("read_file", { filePath: "a.txt" }, "body", false);
    expect(v.kind).toBe("file");
    if (v.kind === "file") expect(v.path).toBe("a.txt");
  });

  it("still falls back to generic when the required field is missing", () => {
    expect(describeTool("run_in_terminal", { explanation: "no command here" }, "", false).kind).toBe(
      "generic",
    );
    expect(describeTool("create_file", { filePath: "x" }, "", false).kind).toBe("generic");
  });
});

describe("Claude Code tool names", () => {
  // A transcript is 402 Bash calls and 66 Edits; without these every one of
  // them renders as pretty-printed JSON next to a VS Code export that renders
  // the same command properly.
  it("reads Bash as a command", () => {
    const v = describeTool("Bash", { command: "ls -la", description: "look" }, "out", false);
    expect(v.kind).toBe("command");
    if (v.kind === "command") expect(v.command).toBe("ls -la");
  });

  it("reads Read, Write and Edit through file_path", () => {
    expect(describeTool("Read", { file_path: "a.ts", limit: 40 }, "body", false).kind).toBe("file");
    const w = describeTool("Write", { file_path: "a.ts", content: "x" }, "", false);
    expect(w.kind).toBe("write");
    if (w.kind === "write") expect(w.path).toBe("a.ts");
    expect(
      describeTool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "", false).kind,
    ).toBe("edit");
  });

  it("reads Glob and Grep as matches, and Skill as a skill", () => {
    expect(describeTool("Glob", { pattern: "**/*.ts" }, "a\nb", false).kind).toBe("matches");
    expect(describeTool("Grep", { pattern: "todo", path: "src" }, "a", false).kind).toBe("matches");
    const s = describeTool("Skill", { skill: "superpowers:brainstorming" }, "ok", false);
    expect(s.kind).toBe("skill");
    if (s.kind === "skill") expect(s.name).toBe("superpowers:brainstorming");
  });

  it("splits an MCP tool into its server and its tool", () => {
    const v = describeTool("mcp__Claude_Browser__navigate", { url: "http://x" }, "ok", false);
    expect(v.kind).toBe("mcp");
    if (v.kind === "mcp") {
      expect(v.server).toBe("Claude_Browser");
      expect(v.tool).toBe("navigate");
    }
  });

  it("keeps underscores that belong to the tool's own name", () => {
    const v = describeTool("mcp__ccd_session__mark_chapter", { title: "x" }, "", false);
    expect(v.kind).toBe("mcp");
    if (v.kind === "mcp") {
      expect(v.server).toBe("ccd_session");
      expect(v.tool).toBe("mark_chapter");
    }
  });

  it("falls back to generic for a malformed mcp name", () => {
    expect(describeTool("mcp__onlyserver", { a: 1 }, "", false).kind).toBe("generic");
  });

  it("refuses an mcp name with an empty half", () => {
    expect(describeTool("mcp____navigate", { a: 1 }, "", false).kind).toBe("generic");
    expect(describeTool("mcp__server__", { a: 1 }, "", false).kind).toBe("generic");
  });

  it("splits only twice, so a tool carrying __ keeps it", () => {
    const v = describeTool("mcp__srv__a__b", {}, "", false);
    if (v.kind !== "mcp") throw new Error("kind");
    expect(v.server).toBe("srv");
    expect(v.tool).toBe("a__b");
  });

  it("carries the mcp payload through unread — the server owns that schema", () => {
    const v = describeTool("mcp__x__y", { anything: [1, 2] }, "out", false);
    if (v.kind !== "mcp") throw new Error("kind");
    expect(v.input).toEqual({ anything: [1, 2] });
    expect(v.output).toBe("out");
  });
});

describe("describeTool — subagents", () => {
  // A fan-out card is the product's headline picture. Rendered as JSON it is a
  // wall of prompt; the pair (type, task) is the whole story.
  it("spawn_agent is one child", () => {
    const v = describeTool("spawn_agent", { type: "explore", task: "map the repo" }, "done", false);
    expect(v.kind).toBe("agents");
    if (v.kind !== "agents") throw new Error("kind");
    expect(v.children).toEqual([{ type: "explore", task: "map the repo", label: null }]);
    expect(v.result).toBe("done");
  });

  it("spawn_agents unrolls its batch in order", () => {
    const v = describeTool(
      "spawn_agents",
      {
        agents: [
          { type: "explore", task: "read the docs" },
          { type: "worker", task: "write the patch" },
        ],
      },
      "--- Subagent 1 ---\nok",
      false,
    );
    if (v.kind !== "agents") throw new Error("kind");
    expect(v.children.map((c) => c.type)).toEqual(["explore", "worker"]);
    expect(v.children[1].task).toBe("write the patch");
  });

  it("Task and Agent read subagent_type/prompt, keeping description as the label", () => {
    for (const name of ["Task", "Agent"]) {
      const v = describeTool(
        name,
        { subagent_type: "code-reviewer", description: "review the diff", prompt: "Look at X" },
        "",
        false,
      );
      if (v.kind !== "agents") throw new Error(`kind for ${name}`);
      expect(v.children).toEqual([{ type: "code-reviewer", task: "Look at X", label: "review the diff" }]);
    }
  });

  it("falls back to generic when a child has no type or no task", () => {
    expect(describeTool("spawn_agent", { type: "explore" }, "", false).kind).toBe("generic");
    expect(describeTool("spawn_agent", { task: "do it" }, "", false).kind).toBe("generic");
    expect(describeTool("Task", { subagent_type: "x", description: "y" }, "", false).kind).toBe("generic");
  });

  it("falls back to generic for an empty or non-array batch", () => {
    expect(describeTool("spawn_agents", { agents: [] }, "", false).kind).toBe("generic");
    expect(describeTool("spawn_agents", { agents: "explore" }, "", false).kind).toBe("generic");
    expect(describeTool("spawn_agents", { agents: [{ type: "explore" }] }, "", false).kind).toBe("generic");
  });
});

describe("describeTool — the plan", () => {
  it("update_plan becomes a checklist", () => {
    const v = describeTool(
      "update_plan",
      {
        steps: [
          { text: "write the test", status: "completed" },
          { text: "make it pass", status: "in_progress" },
        ],
      },
      "ok (2 steps)",
      false,
    );
    expect(v.kind).toBe("plan");
    if (v.kind !== "plan") throw new Error("kind");
    expect(v.steps).toEqual([
      { text: "write the test", status: "completed" },
      { text: "make it pass", status: "in_progress" },
    ]);
  });

  it("TodoWrite says todos/content and means the same list", () => {
    const v = describeTool(
      "TodoWrite",
      { todos: [{ content: "ship it", status: "pending", activeForm: "shipping it" }] },
      "",
      false,
    );
    if (v.kind !== "plan") throw new Error("kind");
    expect(v.steps).toEqual([{ text: "ship it", status: "pending" }]);
  });

  it("a step without a status is shown without one, never invented", () => {
    const v = describeTool("update_plan", { steps: [{ text: "lone step" }] }, "", false);
    if (v.kind !== "plan") throw new Error("kind");
    expect(v.steps).toEqual([{ text: "lone step", status: null }]);
  });

  it("falls back to generic for a missing, empty or textless list", () => {
    expect(describeTool("update_plan", { plan: "x" }, "", false).kind).toBe("generic");
    expect(describeTool("update_plan", { steps: [] }, "", false).kind).toBe("generic");
    // One unreadable row would misreport the plan's length — refuse the whole card.
    expect(
      describeTool("update_plan", { steps: [{ text: "a" }, { status: "pending" }] }, "", false).kind,
    ).toBe("generic");
  });
});

describe("describeTool — the web", () => {
  it("web_fetch and WebFetch keep the URL and the fetched body", () => {
    for (const name of ["web_fetch", "WebFetch", "browse_page"]) {
      const v = describeTool(name, { url: "https://example.com/a" }, "the page text", false);
      if (v.kind !== "web") throw new Error(`kind for ${name}`);
      expect(v.url).toBe("https://example.com/a");
      expect(v.query).toBe(null);
      expect(v.body).toBe("the page text");
    }
  });

  it("web_search and WebSearch keep the query", () => {
    for (const name of ["web_search", "WebSearch"]) {
      const v = describeTool(name, { query: "spectroscope agent" }, "3 results", false);
      if (v.kind !== "web") throw new Error(`kind for ${name}`);
      expect(v.query).toBe("spectroscope agent");
      expect(v.url).toBe(null);
    }
  });

  it("falls back to generic with neither a url nor a query", () => {
    expect(describeTool("WebFetch", { prompt: "summarise" }, "", false).kind).toBe("generic");
  });
});

describe("describeTool — images", () => {
  // The store endpoint serves content-addressed names ONLY
  // (SessionsController.IMAGE_NAME: 64 hex + png|jpg|webp). Anything else must
  // NOT get an <img>: a guaranteed-400 request behind an onError placeholder
  // would look like a missing file instead of an unservable one.
  const sha = "a".repeat(64);

  it("generate_image keeps the prompt and finds its stored blob", () => {
    const v = describeTool(
      "generate_image",
      { prompt: "a beach cat" },
      `Image generated with gemini (gemini-2.5-flash-image): /Users/x/.spectro/images/${sha}.png (image/png, 42 KB). The user sees it in the gallery panel.`,
      false,
    );
    expect(v.kind).toBe("image");
    if (v.kind !== "image") throw new Error("kind");
    expect(v.prompt).toBe("a beach cat");
    expect(v.source).toBe(`/Users/x/.spectro/images/${sha}.png`);
    expect(v.preview).toBe(`/Users/x/.spectro/images/${sha}.png`);
  });

  it("a failed generation keeps the prompt and offers no preview", () => {
    const v = describeTool(
      "generate_image",
      { prompt: "a beach cat" },
      "ERROR: image generation failed: 401",
      true,
    );
    if (v.kind !== "image") throw new Error("kind");
    expect(v.prompt).toBe("a beach cat");
    expect(v.source).toBe(null);
    expect(v.preview).toBe(null);
  });

  it("a pending generation is still an image card", () => {
    const v = describeTool("generate_image", { prompt: "a beach cat" }, undefined, false);
    if (v.kind !== "image") throw new Error("kind");
    expect(v.source).toBe(null);
    expect(v.preview).toBe(null);
  });

  it("a bundled demo asset previews as itself", () => {
    const v = describeTool(
      "generate_image",
      { prompt: "scripted" },
      "Image generated with demo (scripted): /demo/beach-cat.png (image/png, 1 KB).",
      false,
    );
    if (v.kind !== "image") throw new Error("kind");
    expect(v.preview).toBe("/demo/beach-cat.png");
  });

  it("view_image names the workspace file but offers no preview — the store cannot serve it", () => {
    const v = describeTool("view_image", { path: "docs/shot.png" }, "attached", false);
    if (v.kind !== "image") throw new Error("kind");
    expect(v.source).toBe("docs/shot.png");
    expect(v.preview).toBe(null);
    expect(v.prompt).toBe(null);
  });

  it("view_image of a stored blob does preview", () => {
    const v = describeTool("view_image", { path: `~/.spectro/images/${sha}.webp` }, "", false);
    if (v.kind !== "image") throw new Error("kind");
    expect(v.preview).toBe(`~/.spectro/images/${sha}.webp`);
  });

  it("refuses a store-shaped name that is not the content-address contract", () => {
    const v = describeTool("view_image", { path: "/x/.spectro/images/shot.png" }, "", false);
    if (v.kind !== "image") throw new Error("kind");
    expect(v.preview).toBe(null);
  });

  it("falls back to generic without a path or a prompt", () => {
    expect(describeTool("view_image", { file: "a.png" }, "", false).kind).toBe("generic");
    expect(describeTool("generate_image", { p: "a cat" }, "", false).kind).toBe("generic");
  });
});

describe("describeTool — what deliberately stays generic", () => {
  // Small flat objects of short strings already read at a glance as JSON. A
  // shape for each would be several shapes serving one call apiece. Pinned so
  // the decision is visible rather than merely absent.
  //
  // Workflow left this list because its script is not a small flat string.
  // AskUserQuestion and Monitor left it on evidence: 41 transcript calls show
  // AskUserQuestion carrying options with descriptions and previews, and all
  // seven Monitor calls carry a real shell command (three of them multi-line) —
  // the `until` field this list once cited as the thing a command view would
  // drop is not on the wire at all, the loop is inside the command.
  //
  // TaskCreate/TaskUpdate left on the same grounds they were once kept for.
  // Both objections were to the PLAN view — it would drop TaskCreate's
  // description and label an update as step "1" — and neither was an argument
  // that a task has no shape. It has one of its own; see "the task list" below.
  //
  // TaskStop stays, and it is the reason the family could not be routed by its
  // prefix: it stops a spawned run, so its id is an opaque slug under `task_id`
  // and there is no subject, state or description anywhere in the call.
  it("leaves the small-payload harness tools alone", () => {
    const calls: [string, unknown][] = [
      ["TaskStop", { task_id: "wfsbmqs31" }],
      ["ToolSearch", { query: "notebook", max_results: 5 }],
      // The wire field is `message` (SubagentManager's ReportStatusTool reads
      // input.path("message")), not `status` as this pin used to claim.
      ["report_status", { message: "halfway" }],
      // A ranked-excerpt result is not a match list: splitting it on newlines
      // would report a hit count the tool never gave.
      ["semantic_search", { query: "where is the gate" }],
      // A unified diff has no before/after sides to fill an edit view with.
      ["apply_patch", { input: "*** Begin Patch\n*** End Patch\n" }],
    ];
    for (const [name, input] of calls) {
      expect(describeTool(name, input, "ok", false).kind, name).toBe("generic");
    }
  });

  // The generic card is where every unknown tool lands, so a multi-line field
  // in it must still read as text (see splitInput below) — staying generic is
  // not the same as staying unreadable.
  it("still routes an unknown tool with a long field to generic", () => {
    expect(describeTool("notes_write", { note: "line one\nline two" }, "", false).kind).toBe("generic");
  });
});

describe("describeTool — the question", () => {
  // Every literal below is copied from a real AskUserQuestion pair in
  // ~/.claude/projects/…/*.jsonl (41 calls, 53 questions, 150 options). The
  // result is ONE line of prose — a lead-in, `"question"="answer"` pairs, a
  // closing instruction — so the answers are located by the question text the
  // input already carries, never by a regex over the prose.
  const one = (question: string, options: unknown[], multiSelect = false): unknown => ({
    questions: [{ question, header: "Head", multiSelect, options }],
  });
  const opts = [
    { label: "Nach main mergen", description: "merge it" },
    { label: "Auf dem Branch lassen", description: "leave it" },
  ];

  it("marks the chosen option in place among the options", () => {
    const q = "Der UI-Branch ist live-verifiziert. Nach main mergen?";
    const v = describeTool(
      "AskUserQuestion",
      one(q, opts),
      `Your questions have been answered: "${q}"="Nach main mergen". You can now continue with these answers in mind.`,
      false,
    );
    expect(v.kind).toBe("question");
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions).toHaveLength(1);
    const asked = v.questions[0];
    expect(asked.header).toBe("Head");
    expect(asked.question).toBe(q);
    expect(asked.answered).toBe("option");
    expect(asked.answer).toBe("Nach main mergen");
    expect(asked.options.map((o) => o.chosen)).toEqual([true, false]);
    expect(asked.options[0].description).toBe("merge it");
  });

  it("answers each question of a batch from the one result line", () => {
    const a = "Wie tief soll ich JETZT liefern?";
    const b = "Wo lebt edu — worauf zentriere ich das Konzept?";
    const v = describeTool(
      "AskUserQuestion",
      {
        questions: [
          { question: a, header: "Umfang", multiSelect: false, options: [{ label: "Nur das Konzept" }] },
          { question: b, header: "Platzierung", multiSelect: false, options: [{ label: "Nur In-App-Tab" }] },
        ],
      },
      `Your questions have been answered: "${a}"="Nur das Konzept", "${b}"="Nur In-App-Tab". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions.map((q) => q.answer)).toEqual(["Nur das Konzept", "Nur In-App-Tab"]);
    expect(v.questions.map((q) => q.answered)).toEqual(["option", "option"]);
  });

  it("marks every option of a multi-select answer", () => {
    const q = "Womit mache ich als Nächstes weiter?";
    const v = describeTool(
      "AskUserQuestion",
      one(
        q,
        [
          { label: "Konzept-Dok + Karte 31" },
          { label: "Alles committen" },
          { label: "Noch mehr Lektionen" },
          { label: "Erst so lassen" },
        ],
        true,
      ),
      `Your questions have been answered: "${q}"="Konzept-Dok + Karte 31,Alles committen,Noch mehr Lektionen". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("option");
    expect(v.questions[0].options.map((o) => o.chosen)).toEqual([true, true, true, false]);
  });

  it("reads a comma-carrying label as one choice, not as two", () => {
    // Real labels contain commas ("Ja, deployen"), so the multi-select answer
    // cannot be split on the separator.
    const q = "Soll ich deployen?";
    const v = describeTool(
      "AskUserQuestion",
      one(q, [{ label: "Ja, deployen" }, { label: "Nur lokal lassen" }], true),
      `Your questions have been answered: "${q}"="Ja, deployen". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("option");
    expect(v.questions[0].options.map((o) => o.chosen)).toEqual([true, false]);
  });

  it("keeps a free-text reply as text and marks no option", () => {
    const q = "Wie soll edu in die neue App?";
    const free = "sofort react flow, aber schreibe die CLAUDE.md und dokus mit zielen";
    const v = describeTool(
      "AskUserQuestion",
      one(q, [{ label: "Erst einbetten, später portieren" }, { label: "Sofort nativ React Flow" }]),
      `Your questions have been answered: "${q}"="${free}". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("text");
    expect(v.questions[0].answer).toBe(free);
    expect(v.questions[0].options.every((o) => !o.chosen)).toBe(true);
  });

  it("reads a dismissal as a dismissal, not as a free-text answer", () => {
    const q = "Für welchen Baum soll ich ein privates GitHub-Repo anlegen?";
    const v = describeTool(
      "AskUserQuestion",
      one(q, [{ label: "Die Heimat ~/Spectroscope (Empfohlen)" }], true),
      `The user answered: "${q}"="[User dismissed — do not proceed, wait for next instruction]". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("dismissed");
    expect(v.questions[0].answer).toBe("[User dismissed — do not proceed, wait for next instruction]");
    expect(v.questions[0].options.every((o) => !o.chosen)).toBe(true);
  });

  it("reports an unanswered question as unanswered, never as unasked", () => {
    const q = "Womit starten wir?";
    // Pending, interrupted, and errored calls all reach the card the same way:
    // the question is there and no answer is.
    for (const out of [undefined, "", "<tool_use_error>InputValidationError</tool_use_error>"]) {
      const v = describeTool("AskUserQuestion", one(q, [{ label: "Hier" }]), out, out !== undefined);
      if (v.kind !== "question") throw new Error("kind");
      expect(v.questions[0].question).toBe(q);
      expect(v.questions[0].answered).toBe("none");
      expect(v.questions[0].answer).toBe(null);
    }
  });

  it("leaves one question of a batch unanswered without shifting the others", () => {
    const a = "Erste Frage?";
    const b = "Zweite Frage?";
    const v = describeTool(
      "AskUserQuestion",
      {
        questions: [
          { question: a, options: [{ label: "A1" }] },
          { question: b, options: [{ label: "B1" }] },
        ],
      },
      `Your questions have been answered: "${b}"="B1". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("none");
    expect(v.questions[1].answer).toBe("B1");
  });

  it("keeps an option's preview and survives the result echoing it back", () => {
    // A chosen option's own multi-line preview is appended to the result after
    // the answer's closing quote; it is arbitrary text and must not be read as
    // part of the answer.
    const q = "Was soll die Galerie zeigen?";
    const preview = "Landing #shots:  fan-out\nGalerie-Karte:   fan-out";
    const v = describeTool(
      "AskUserQuestion",
      one(q, [{ label: "Fan-out überall (auch Galerie)", description: "d", preview }]),
      `Your questions have been answered: "${q}"="Fan-out überall (auch Galerie)" selected preview:\n${preview}. You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answer).toBe("Fan-out überall (auch Galerie)");
    expect(v.questions[0].answered).toBe("option");
    expect(v.questions[0].options[0].preview).toBe(preview);
  });

  it("survives a question that carries quotes of its own", () => {
    const q = 'Soll ich das Dev-Portal (mit dem neuen "run a fleet"-Abschnitt) deployen?';
    const v = describeTool(
      "AskUserQuestion",
      one(q, [{ label: "Ja, deployen" }]),
      `Your questions have been answered: "${q}"="Ja, deployen". You can now continue with these answers in mind.`,
      false,
    );
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].answered).toBe("option");
    expect(v.questions[0].options[0].chosen).toBe(true);
  });

  it("defaults the fields a question may omit, and never invents an option", () => {
    const v = describeTool("AskUserQuestion", one("Q?", ["bare label"]), "", false);
    if (v.kind !== "question") throw new Error("kind");
    expect(v.questions[0].multiSelect).toBe(false);
    expect(v.questions[0].options).toEqual([
      { label: "bare label", description: null, preview: null, chosen: false },
    ]);
    const noHeader = describeTool(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "a" }] }] },
      "",
      false,
    );
    if (noHeader.kind !== "question") throw new Error("kind");
    expect(noHeader.questions[0].header).toBe(null);
  });

  it("falls back to generic when the questions are missing, empty or unreadable", () => {
    expect(describeTool("AskUserQuestion", { q: "which?" }, "", false).kind).toBe("generic");
    expect(describeTool("AskUserQuestion", { questions: [] }, "", false).kind).toBe("generic");
    // A question with no text, or an option with no label, would misstate the
    // decision — refuse the whole card as spawn_agents does.
    expect(
      describeTool("AskUserQuestion", { questions: [{ options: [{ label: "a" }] }] }, "", false).kind,
    ).toBe("generic");
    expect(describeTool("AskUserQuestion", { questions: [{ question: "Q?" }] }, "", false).kind).toBe(
      "generic",
    );
    expect(
      describeTool(
        "AskUserQuestion",
        { questions: [{ question: "Q?", options: [{ description: "d" }] }] },
        "",
        false,
      ).kind,
    ).toBe("generic");
  });

  it("refuses the double-escaped payload the runtime already rejected", () => {
    // __unparsedToolInput carries the model's raw JSON as a STRING because it
    // did not parse. Unwrapping it would lay out a decision nobody was ever
    // shown: the call errored, so no question reached the person.
    const v = describeTool(
      "AskUserQuestion",
      { __unparsedToolInput: { raw: '{"questions": [{"question":"Wie?","options":[]}]}', len: 991 } },
      "<tool_use_error>InputValidationError: AskUserQuestion was called with input that could not be parsed as JSON.</tool_use_error>",
      true,
    );
    expect(v.kind).toBe("generic");
  });
});

// Every payload below is a call taken verbatim out of the transcripts: 256
// TaskCreate, 434 TaskUpdate, one TaskList. The corpus is what settled the
// shape — 418 of the 434 updates carry nothing but an id and a status, which is
// why an update reads as a row and not as a plan step called "1".
describe("describeTool — the task list", () => {
  it("a creation leads with its subject and keeps the description under it", () => {
    const v = describeTool(
      "TaskCreate",
      {
        subject: "Recon: spectro-local provider class + CancelSignal semantics",
        description:
          'Verify which LlmProvider class ServerProviders.build("spectro-local") returns and whether CancelSignal.onCancel fires immediately when registered on an already-cancelled signal. Facts before reproduction.',
        activeForm: "Checking spectro-local provider class + CancelSignal semantics",
      },
      "Task #1 created successfully: Recon: spectro-local provider class + CancelSignal semantics",
      false,
    );
    expect(v.kind).toBe("task");
    if (v.kind !== "task") throw new Error("kind");
    expect(v.op).toBe("create");
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].subject).toBe("Recon: spectro-local provider class + CancelSignal semantics");
    expect(v.rows[0].description).toContain("Facts before reproduction.");
    // A new task has no state in either half of the call, so the view claims none.
    expect(v.rows[0].status).toBe(null);
  });

  it("takes the id from the result, which is the only half that carries one", () => {
    const v = describeTool(
      "TaskCreate",
      {
        subject: "Fix/harden stop path per repro findings (TDD)",
        description: "Fix whatever the repro shows.",
      },
      "Task #3 created successfully: Fix/harden stop path per repro findings (TDD)",
      false,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.rows[0].id).toBe("3");
    // The line said nothing the view does not already carry, so it is not
    // reprinted underneath as an output.
    expect(v.result).toBe("");
  });

  it("a creation still standing open shows its subject and no id", () => {
    const v = describeTool("TaskCreate", { subject: "Ship it", description: "all of it" }, undefined, false);
    if (v.kind !== "task") throw new Error("kind");
    expect(v.rows[0].id).toBe(null);
    expect(v.rows[0].subject).toBe("Ship it");
    expect(v.wrote).toBe("silent");
  });

  it("an update is one row: the task the result confirms, and where it went", () => {
    const v = describeTool(
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
      false,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.op).toBe("update");
    expect(v.rows).toEqual([
      { id: "1", subject: null, description: null, status: "completed", blockedBy: [] },
    ]);
    expect(v.wrote).toBe("named");
    expect(v.result).toBe("");
  });

  it("an update that rewrote the text carries the new words, not the old", () => {
    const v = describeTool(
      "TaskUpdate",
      {
        taskId: "9",
        status: "in_progress",
        subject: "Block 1 — P1 legibility (aggregate/roll-up/LOD/clustering)",
        description: "Fleet canvas legibility folds: aggregate-by-name, subtree roll-ups, level-of-detail.",
      },
      "Updated task #9 subject, description, status",
      false,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.rows[0].subject).toBe("Block 1 — P1 legibility (aggregate/roll-up/LOD/clustering)");
    expect(v.rows[0].description).toContain("aggregate-by-name");
    expect(v.rows[0].status).toBe("in_progress");
  });

  it("reads a dependency out of addBlockedBy", () => {
    const v = describeTool(
      "TaskUpdate",
      { taskId: "3", addBlockedBy: ["1", "2"] },
      "Updated task #3 blockedBy",
      false,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.rows[0].blockedBy).toEqual(["1", "2"]);
    expect(v.rows[0].status).toBe(null);
  });

  it("says so when the result confirms the update and names no field", () => {
    // Twice in 434 calls: the status asked for was the one the task already
    // had, so the list did not move. Rendering "completed" alone would report a
    // transition the tool says did not happen.
    const v = describeTool("TaskUpdate", { taskId: "9", status: "completed" }, "Updated task #9 ", false);
    if (v.kind !== "task") throw new Error("kind");
    expect(v.wrote).toBe("nothing");
  });

  it("keeps a result it cannot read whole, rather than swallowing it", () => {
    const v = describeTool(
      "TaskUpdate",
      { taskId: "44", status: "completed" },
      "<tool_use_error>No task #44.</tool_use_error>",
      true,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.wrote).toBe("silent");
    expect(v.result).toBe("<tool_use_error>No task #44.</tool_use_error>");
  });

  it("a listing becomes the roster it printed", () => {
    const v = describeTool(
      "TaskList",
      {},
      "#1 [completed] Preflight: product-home diff committen, Harness-Baseline grün\n" +
        "#2 [completed] Brand-Tokens in spectro-web verankern (espresso root + paper light)\n" +
        "#3 [in_progress] Logo-Set + Favicon in spectro-web\n",
      false,
    );
    if (v.kind !== "task") throw new Error("kind");
    expect(v.op).toBe("list");
    expect(v.rows).toHaveLength(3);
    expect(v.rows[2]).toEqual({
      id: "3",
      subject: "Logo-Set + Favicon in spectro-web",
      description: null,
      status: "in_progress",
      blockedBy: [],
    });
  });

  it("falls back to generic when one roster line does not parse", () => {
    // One unreadable line would misstate the list's length as much as its
    // content, the same rule the plan and the question already follow.
    expect(describeTool("TaskList", {}, "#1 [completed] fine\nNo further tasks.\n", false).kind).toBe(
      "generic",
    );
  });

  it("falls back to generic without the field that makes the call a task", () => {
    expect(describeTool("TaskCreate", { description: "no subject here" }, "", false).kind).toBe("generic");
    expect(describeTool("TaskUpdate", { status: "completed" }, "", false).kind).toBe("generic");
  });

  it("leaves the background-job verbs generic: a slug is not a task number", () => {
    // TaskStop and TaskOutput stop and poll a SPAWNED RUN. Their id space is an
    // opaque slug, their key is task_id rather than taskId, and they carry no
    // subject, status or description at all — the only thing they share with
    // the list above is the word "task". Drawn as a task row, a slug would land
    // where a reader has learnt to read "#3".
    expect(
      describeTool(
        "TaskStop",
        { task_id: "wfsbmqs31" },
        '{"message":"Successfully stopped task: wfsbmqs31 (Research real syntax-highlighting options)","task_id":"wfsbmqs31","task_type":"local_workflow"}',
        false,
      ).kind,
    ).toBe("generic");
    expect(
      describeTool(
        "TaskOutput",
        { task_id: "w9kv07zis", block: false, timeout: 1000 },
        "<status>running</status>",
        false,
      ).kind,
    ).toBe("generic");
    // TaskGet has no call anywhere in the corpus, so there is no observed input
    // or result to build a shape on. It stays with the fallback until one exists.
    expect(describeTool("TaskGet", { taskId: "3" }, "#3 [completed] ship it", false).kind).toBe("generic");
  });
});

describe("describeTool — the routings that reuse a view", () => {
  it("reads Monitor as a command", () => {
    // All seven transcript calls: { command, description, persistent,
    // timeout_ms } — the same drop of siblings the Bash and run_in_terminal
    // routings already accept.
    const v = describeTool(
      "Monitor",
      {
        command: 'until grep -q done log; do sleep 5; done\necho "ready"',
        description: "notarization verdict",
        timeout_ms: 2_100_000,
        persistent: false,
      },
      "ready",
      false,
    );
    expect(v.kind).toBe("command");
    if (v.kind !== "command") throw new Error("kind");
    expect(v.command).toContain("until grep");
  });

  it("reads grep_search and file_search as matches through their own field names", () => {
    const g = describeTool(
      "grep_search",
      { query: "prettyJson", includePattern: "src" },
      "src/a.ts:1",
      false,
    );
    expect(g.kind).toBe("matches");
    if (g.kind !== "matches") throw new Error("kind");
    expect(g.pattern).toBe("prettyJson");
    expect(g.path).toBe("src");
    expect(describeTool("file_search", { query: "**/*.tsx" }, "a.tsx", false).kind).toBe("matches");
  });

  it("still falls back to generic when the searched-for field is absent", () => {
    expect(describeTool("grep_search", { isRegexp: true }, "", false).kind).toBe("generic");
    expect(describeTool("Monitor", { description: "no command here" }, "", false).kind).toBe("generic");
  });
});

describe("splitInput — a multi-line string is a block, not a JSON value", () => {
  // JSON.stringify escapes every newline, so any field carrying code or prose
  // becomes one logical line of visible \n. The shape stays in the object; the
  // text moves out to where line breaks are real.
  it("lifts a newline-carrying field out and leaves a reference behind", () => {
    const script = "const a = 1;\nconst b = 2;\n";
    const split = splitInput("Workflow", { script, timeout: 30 });
    expect(split.shape).toEqual({ script: "... (2 lines below)", timeout: 30 });
    expect(split.blocks).toEqual([{ key: "script", text: script, lang: "javascript" }]);
  });

  it("keeps scalars and single-line strings inside the object", () => {
    const split = splitInput("Bash", { command: "ls -la", timeout: 5, quiet: true, nothing: null });
    expect(split.blocks).toEqual([]);
    expect(split.shape).toEqual({ command: "ls -la", timeout: 5, quiet: true, nothing: null });
  });

  it("lifts every multi-line field, in the order the call sent them", () => {
    const split = splitInput("x", { a: "1\n2", n: 7, b: "3\n4" });
    expect(split.blocks.map((b) => b.key)).toEqual(["a", "b"]);
    expect(split.shape).toEqual({ a: "... (2 lines below)", n: 7, b: "... (2 lines below)" });
  });

  it("reads a command as shell and an unnamed field as plain", () => {
    expect(splitInput("Monitor", { command: "cd /tmp\ngrep -r x ." }).blocks[0].lang).toBe("shell");
    expect(splitInput("notes_write", { note: "dear diary\nit rained" }).blocks[0].lang).toBeNull();
  });

  it("takes a content language from a sibling path, never from the key alone", () => {
    expect(splitInput("w", { path: "a/b.py", content: "import os\nprint(1)" }).blocks[0].lang).toBe("python");
    expect(splitInput("w", { content: "import os\nprint(1)" }).blocks[0].lang).toBeNull();
    expect(splitInput("w", { path: "notes.txt", content: "one\ntwo" }).blocks[0].lang).toBeNull();
  });

  it("believes a language the tool named itself", () => {
    const split = splitInput("mcp__db__run", { language: "sql", code: "select 1\nfrom t" });
    expect(split.blocks[0].lang).toBe("sql");
  });

  it("takes a language from the tool's own name when nothing else says", () => {
    // 486 transcript calls send their script as `text` with no language field
    // and no sibling path. The tool NAME is the only evidence in the call.
    const split = splitInput("mcp__Claude_Browser__javascript_tool", {
      action: "javascript_exec",
      text: "const a = 1;\nreturn a;",
    });
    expect(split.blocks[0].lang).toBe("javascript");
  });

  it("reads only the tool half of an MCP name, never the server's", () => {
    // A server name describes a product; it says nothing about a payload.
    expect(
      splitInput("mcp__python_helper__list_notes", { text: "dear diary\nit rained" }).blocks[0].lang,
    ).toBeNull();
    expect(splitInput("mcp__x__run_python", { code: "import os\nprint(1)" }).blocks[0].lang).toBe("python");
  });

  it("does not read a language out of an ordinary word in a tool name", () => {
    // `console`, `go` and `set` are real fence aliases and ordinary tool-name
    // words both. Painting a whole block the wrong colour reads as a lie about
    // the code, so these stay plain.
    expect(splitInput("mcp__chrome__read_console_messages", { text: "a\nb" }).blocks[0].lang).toBeNull();
    expect(splitInput("mcp__browser__go_to_page", { text: "a\nb" }).blocks[0].lang).toBeNull();
    expect(splitInput("mcp__x__set_view", { text: "a\nb" }).blocks[0].lang).toBeNull();
  });

  it("only lets the name colour the field the tool operates on", () => {
    const split = splitInput("mcp__Claude_Browser__javascript_tool", {
      text: "const a = 1;\nreturn a;",
      description: "what this does\nover two lines",
    });
    expect(split.blocks.map((b) => [b.key, b.lang])).toEqual([
      ["text", "javascript"],
      ["description", null],
    ]);
  });

  it("takes a code field's language from its sibling path before the name", () => {
    // insert_edit_into_file sends a partial edit under `code` next to filePath.
    const split = splitInput("insert_edit_into_file", {
      filePath: "src/a.py",
      code: "def f():\n    return 1",
    });
    expect(split.blocks[0].lang).toBe("python");
  });

  it("passes a non-object payload through untouched", () => {
    for (const input of ["a\nb", 42, null, ["a\nb"]]) {
      const split = splitInput("x", input);
      expect(split.shape).toEqual(input);
      expect(split.blocks).toEqual([]);
    }
  });

  it("counts lines without the trailing newline, and keeps the text byte-exact", () => {
    const split = splitInput("x", { body: "one\ntwo\nthree\n" });
    expect(split.shape).toEqual({ body: "... (3 lines below)" });
    expect(split.blocks[0].text).toBe("one\ntwo\nthree\n");
    // A one-line field that merely ends in a break still reads as one line.
    expect(splitInput("x", { body: "only\n" }).shape).toEqual({ body: "... (1 line below)" });
  });
});

describe("describeTool — the workflow", () => {
  // The script carries its own front matter as a pure literal. It is READ, not
  // evaluated, so a broken or hostile meta costs the header and nothing else.
  const script = [
    "export const meta = {",
    '  name: "review-diff",',
    '  description: "Read the diff, then verify each finding.",',
    '  phases: ["scan", "verify", "report"],',
    "};",
    "",
    "export async function run(ctx) {",
    "  await ctx.spawn('reviewer');",
    "}",
    "",
  ].join("\n");

  it("leads with the name, the description and the phases", () => {
    const v = describeTool("Workflow", { script }, "3 phases done", false);
    expect(v.kind).toBe("workflow");
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.name).toBe("review-diff");
    expect(v.description).toBe("Read the diff, then verify each finding.");
    expect(v.phases).toEqual(["scan", "verify", "report"]);
    expect(v.script).toBe(script);
    expect(v.result).toBe("3 phases done");
  });

  it("reads phases given as objects by their own name", () => {
    const v = describeTool(
      "Workflow",
      {
        script:
          'const meta = {\n  phases: [{ name: "plan", agents: 1 }, { name: "build", agents: 3 }],\n  name: "two-step",\n};\n',
      },
      "",
      false,
    );
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.phases).toEqual(["plan", "build"]);
    // The nested `name:` of a phase must not be mistaken for the workflow's.
    expect(v.name).toBe("two-step");
  });

  it("survives a brace and a newline inside the description", () => {
    const v = describeTool(
      "Workflow",
      { script: 'export const meta = {\n  description: "closes the } brace\\nand wraps",\n};\n' },
      "",
      false,
    );
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.description).toBe("closes the } brace\nand wraps");
  });

  it("resolves the escapes a source literal is allowed to use", () => {
    const v = describeTool(
      "Workflow",
      {
        script:
          "const meta = {\n  name: \"read \\u2014 then write\",\n  description: 'it\\u2019s fine',\n};\n",
      },
      "",
      false,
    );
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.name).toBe("read — then write");
    expect(v.description).toBe("it’s fine");
  });

  it("shows the script alone when the meta is missing or unparseable", () => {
    for (const src of ["export async function run() {}\n", "export const meta = { name: \n"]) {
      const v = describeTool("Workflow", { script: src }, "", false);
      if (v.kind !== "workflow") throw new Error("kind");
      expect(v.name).toBe(null);
      expect(v.phases).toEqual([]);
      expect(v.script).toBe(src);
    }
  });

  it("names a saved workflow that travels without a script", () => {
    const v = describeTool("Workflow", { name: "nightly-audit", args: { depth: 2 } }, "ok", false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.name).toBe("nightly-audit");
    expect(v.script).toBe(null);
    expect(v.args).toEqual({ depth: 2 });
  });

  it("names the file when the script travels as a path", () => {
    const v = describeTool("Workflow", { scriptPath: "wf/audit.mjs" }, "", false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.scriptPath).toBe("wf/audit.mjs");
    expect(v.script).toBe(null);
  });

  it("falls back to generic with no script, path or name", () => {
    expect(describeTool("Workflow", { args: { a: 1 } }, "", false).kind).toBe("generic");
  });
});

// The run half of a Workflow call. Measured in the owner's own session
// (3e010de0…jsonl): 40 launches, 37 notifications, and the notification is a
// SEPARATE user message arriving up to nineteen minutes later — so the join is
// the importer's, and what reaches describeTool is the flattened section
// claudeCode.ts writes under the receipt. Every payload below is that format,
// over counters copied out of that file.
describe("describeTool — the workflow run", () => {
  const script = [
    "export const meta = {",
    '  name: "lab-repair",',
    '  phases: [{ title: "Data" }, { title: "Fix" }, { title: "Verify" }],',
    "};",
    "",
  ].join("\n");

  const RECEIPT = [
    "Workflow launched in background. Task ID: w82qt1zg0",
    "Summary: Repair the lab layout",
    "",
    "You will be notified when it completes. Use /workflows to watch live progress.",
  ].join("\n");

  const USAGE =
    "agent_count=3 agents_done=1 agents_error=2 agents_skipped=0 agents_empty_result=0 " +
    "subagent_tokens=604733 tool_uses=313 duration_ms=3801742";

  /** The receipt with one outcome section joined under it. */
  const joined = (over: { failures?: string; result?: string; usage?: string; status?: string } = {}) =>
    [
      RECEIPT,
      "",
      `--- task w7cocjg6h · ${over.status ?? "completed"} ---`,
      "output-file: /private/tmp/tasks/w7cocjg6h.output",
      "summary: Dynamic workflow completed",
      `result: ${over.result ?? '{"data":["the finding"]}'}`,
      "diagnostics: Per-agent results: /tmp/wf/journal.jsonl",
      ...(over.failures === undefined ? [] : [`failures: ${over.failures}`]),
      `usage: ${over.usage ?? USAGE}`,
    ].join("\n");

  /** What the importer writes when the transcript ended before the outcome did. */
  const unfinished = `${RECEIPT}\n\n--- task w82qt1zg0 · no result by the end of the transcript ---`;

  it("reads a launch the transcript outlived as still open, not as finished", () => {
    const v = describeTool("Workflow", { script }, unfinished, false);
    if (v.kind !== "workflow") throw new Error("kind");
    // The one state this card existed to stop getting wrong.
    expect(v.stage).toBe("launched");
    expect(v.run).toBe(null);
  });

  it("reads a receipt nothing was ever joined to the same way", () => {
    const v = describeTool("Workflow", { script }, RECEIPT, false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("launched");
  });

  it("separates a call still on the wire from one that was launched", () => {
    const v = describeTool("Workflow", { script }, undefined, false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("pending");
  });

  it("reads an errored launch as failed, never as running", () => {
    const v = describeTool("Workflow", { scriptPath: "wf/a.js" }, "ENOENT: no such file", true);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("failed");
    expect(v.run).toBe(null);
  });

  it("reads the outcome out of the section the importer joined on", () => {
    const v = describeTool("Workflow", { script }, joined(), false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("done");
    const run = v.run;
    if (run === null) throw new Error("run");
    expect(run.status).toBe("completed");
    expect(run.agents).toBe(3);
    expect(run.done).toBe(1);
    expect(run.errors).toBe(2);
    expect(run.tokens).toBe(604733);
    expect(run.toolUses).toBe(313);
    expect(run.durationMs).toBe(3801742);
    expect(run.result).toBe('{"data":["the finding"]}');
  });

  it("leaves the launch receipt as the result, with the section cut off it", () => {
    const v = describeTool("Workflow", { script }, joined(), false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.result).toBe(RECEIPT);
    expect(v.result).not.toContain("--- task");
  });

  it("takes the ending, not a progress report that came before it", () => {
    // A task can report progress first; each report is joined on in arrival
    // order, so the LAST section is the one that says what happened.
    const out = `${RECEIPT}\n\n--- task w7cocjg6h ---\nsummary: still going\nevent: progress\n\n${joined().split("\n\n").slice(1).join("\n\n")}`;
    const v = describeTool("Workflow", { script }, out, false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("done");
    expect(v.run?.agents).toBe(3);
  });

  it("reads a run that only ever reported progress as still open", () => {
    const out = `${RECEIPT}\n\n--- task w7cocjg6h ---\nsummary: still going\n\n--- task w7cocjg6h · ${"no result by the end of the transcript"} ---`;
    const v = describeTool("Workflow", { script }, out, false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.stage).toBe("launched");
  });

  it("names every agent that died, and where the label puts it", () => {
    const v = describeTool(
      "Workflow",
      { script },
      joined({
        failures: [
          "[fix:geometry] failed: You've hit your monthly spend limit",
          "[fix:jsontree] failed: You've hit your monthly spend limit",
          "[verify] failed: You've hit your monthly spend limit",
        ].join("\n"),
      }),
      false,
    );
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.run?.failures).toEqual([
      { label: "fix:geometry", phase: "Fix", reason: "You've hit your monthly spend limit" },
      { label: "fix:jsontree", phase: "Fix", reason: "You've hit your monthly spend limit" },
      { label: "verify", phase: "Verify", reason: "You've hit your monthly spend limit" },
    ]);
  });

  it("keeps a failure whose label names no phase rather than dropping it", () => {
    const v = describeTool("Workflow", { script }, joined({ failures: "[web] failed: timed out" }), false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.run?.failures).toEqual([{ label: "web", phase: null, reason: "timed out" }]);
  });

  it("keeps a failure line that carries no label at all", () => {
    const v = describeTool("Workflow", { script }, joined({ failures: "the run was cancelled" }), false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.run?.failures).toEqual([{ label: null, phase: null, reason: "the run was cancelled" }]);
  });

  it("reports a counter the outcome omitted as unknown, not as zero", () => {
    const v = describeTool("Workflow", { script }, joined({ usage: "agent_count=2" }), false);
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.run?.agents).toBe(2);
    expect(v.run?.done).toBe(null);
    expect(v.run?.tokens).toBe(null);
  });

  it("does not let a result that writes about failures invent one", () => {
    // The join is flat text and an agent's own words sit in `result`. In this
    // repo those words are ABOUT failing agents, so a reader of the section has
    // to know that the real field is the last one, not the quoted one.
    const v = describeTool(
      "Workflow",
      { script },
      joined({
        result: "the card must show\nfailures: not like this\nunder the numbers",
        failures: "[verify] failed: monthly spend limit",
      }),
      false,
    );
    if (v.kind !== "workflow") throw new Error("kind");
    expect(v.run?.failures).toEqual([{ label: "verify", phase: "Verify", reason: "monthly spend limit" }]);
    expect(v.run?.result).toContain("failures: not like this");
  });
});

describe("runStats — the scannable row", () => {
  const run = {
    status: "completed",
    agents: 11,
    done: 11,
    errors: 0,
    skipped: 0,
    empty: 0,
    tokens: 1558378,
    toolUses: 128,
    durationMs: 1140752,
    failures: [],
    result: "",
  };

  it("reads as done of total, in the app's own number formats", () => {
    expect(runStats(run)).toEqual([
      { key: "agents", value: "11 / 11", bad: false },
      { key: "tokens", value: "1558k", bad: false },
      { key: "tools", value: "128", bad: false },
      { key: "elapsed", value: "19 m 1 s", bad: false },
    ]);
  });

  it("calls the dead agents out in the row itself", () => {
    const stats = runStats({ ...run, agents: 3, done: 1, errors: 2 });
    expect(stats[0]).toEqual({ key: "agents", value: "1 / 3", bad: false });
    expect(stats[1]).toEqual({ key: "failed", value: "2", bad: true });
  });

  it("counts the quiet losses too, and only when there are any", () => {
    const stats = runStats({ ...run, skipped: 1, empty: 2 });
    expect(stats.map((s) => s.key)).toEqual(["agents", "skipped", "empty", "tokens", "tools", "elapsed"]);
    expect(stats.find((s) => s.key === "empty")).toEqual({ key: "empty", value: "2", bad: true });
  });

  it("leaves out a number the outcome never reported", () => {
    const stats = runStats({ ...run, tokens: null, toolUses: null, durationMs: null });
    expect(stats.map((s) => s.key)).toEqual(["agents"]);
  });
});

describe("splitInput — a one-line program is a block too", () => {
  // The MCP browser tool sends its whole script as ONE string with no newline
  // in it, so the "has a \n" rule left a 900-character program sitting in the
  // JSON shape as a scalar. The language was already known (the tool NAMES
  // itself javascript and `text` is an operand key); only the lifting rule was
  // wrong.
  const MCP = "mcp__Claude_Browser__javascript_tool";

  it("lifts a long one-line script out of the shape", () => {
    const text =
      "(async()=>{const slider=document.querySelector('input');" +
      "setter.call(slider,'33');await new Promise(r=>setTimeout(r,200));" +
      "return JSON.stringify({ok:true})})()";
    const split = splitInput(MCP, { action: "javascript_exec", text });
    expect(split.blocks.map((b) => b.key)).toEqual(["text"]);
    expect(split.blocks[0].lang).toBe("javascript");
    expect(split.shape).toEqual({ action: "javascript_exec", text: "... (1 line below)" });
  });

  it("breaks the lifted line after a statement, so it can be read", () => {
    const text = "const a=1;const b=2;return a+b";
    const split = splitInput(MCP, { text: text + ";".repeat(0) + " ".repeat(0) + "x".repeat(200) });
    expect(split.blocks[0].text.split("\n").length).toBeGreaterThan(1);
  });

  it("never breaks inside a string literal", () => {
    // The whole hazard in one line: a semicolon the program MEANS as data.
    const text = "const s='a;b;c';fn(s);" + "y".repeat(200);
    const split = splitInput(MCP, { text });
    expect(split.blocks[0].text).toContain("'a;b;c'");
  });

  it("leaves a short one-liner in the shape where it reads fine", () => {
    const split = splitInput(MCP, { text: "return 1" });
    expect(split.blocks).toEqual([]);
    expect(split.shape).toEqual({ text: "return 1" });
  });

  it("leaves a long one-liner alone when nothing says it is code", () => {
    const prose = "w".repeat(400);
    const split = splitInput("some_tool", { note: prose });
    expect(split.blocks).toEqual([]);
    expect(split.shape).toEqual({ note: prose });
  });
});

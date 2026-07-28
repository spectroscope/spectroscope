// The structured tool view (card 94): each tool call is described as the SHAPE
// it really is — a file read, an edit, a listing, a command — so the card can
// render it as itself instead of as two JSON blobs. Pure, DOM-free.

import { describe, expect, it } from "vitest";
import { describeTool, splitInput } from "./toolViews";

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
  // TaskCreate/TaskUpdate stay: a plan view would drop TaskCreate's
  // description, which is its substance, and TaskUpdate carries no text to put
  // in a step (418 of 435 calls are taskId + status alone).
  it("leaves the small-payload harness tools alone", () => {
    const calls: [string, unknown][] = [
      ["TaskUpdate", { taskId: "t1", status: "done" }],
      ["TaskCreate", { subject: "s", description: "d", activeForm: "a" }],
      ["TaskStop", { taskId: "t1" }],
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

// The structured tool view (card 94): each tool call is described as the SHAPE
// it really is — a file read, an edit, a listing, a command — so the card can
// render it as itself instead of as two JSON blobs. Pure, DOM-free.

import { describe, expect, it } from "vitest";
import { describeTool } from "./toolViews";

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
  // shape for each would be five shapes serving one call apiece, and Monitor's
  // stop condition or AskUserQuestion's options would be the part that got
  // dropped. Pinned so the decision is visible rather than merely absent.
  it("leaves the small-payload harness tools alone", () => {
    const calls: [string, unknown][] = [
      ["TaskUpdate", { taskId: "t1", status: "done" }],
      ["TaskCreate", { subject: "s", description: "d", activeForm: "a" }],
      ["TaskStop", { taskId: "t1" }],
      ["ToolSearch", { query: "notebook", max_results: 5 }],
      ["Monitor", { description: "wait", command: "curl -s x", until: "200" }],
      ["Workflow", { script: "step one\nstep two" }],
      ["AskUserQuestion", { questions: [{ question: "which?", options: ["a", "b"] }] }],
      ["report_status", { status: "halfway" }],
    ];
    for (const [name, input] of calls) {
      expect(describeTool(name, input, "ok", false).kind, name).toBe("generic");
    }
  });
});

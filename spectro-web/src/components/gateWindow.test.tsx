// Card 382: the permission ask as a window, and what it has to carry.
//
// No DOM in this suite (house rule), so the window is rendered with
// react-dom/server and read as markup. That is enough for every claim made
// here: each one is about what the window SAYS, or about a list the trap
// derives from the markup it is standing in.
//
// The focus-trap check deserves a word. The count it compares against is not a
// copy of the component's selector — it is the HTML rule for what a browser
// focuses (button, input, select, textarea, a[href], explicit tabindex). If the
// trap's selector drops one of those element kinds, the two numbers stop
// matching. With the old selector, `button, [tabindex="0"]`, they did not
// match: 3 against 4.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionDialog, GATE_FOCUSABLE_SELECTOR, gateCommand } from "./PermissionDialog";
import type { AgentInfo, PendingPermission, ToolCard } from "../state/reducer";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { read, stripComments } from "../testkit/source";

const child: PendingPermission = {
  callId: "c9",
  agentId: "sub-7",
  name: "Bash",
  input: { command: "rm -rf build" },
};

const agents: AgentInfo[] = [
  {
    id: "main",
    parentId: null,
    label: null,
    task: "",
    state: "working",
    lastStatus: null,
    inTokens: 0,
    outTokens: 0,
  },
  {
    id: "sub-7",
    parentId: "main",
    label: "build_plan",
    task: "tidy the build folder",
    state: "working",
    lastStatus: null,
    inTokens: 0,
    outTokens: 0,
  },
];

const card = (callId: string, name: string, permission: "allowed" | "denied"): ToolCard => ({
  callId,
  agentId: "main",
  name,
  input: {},
  status: "ok",
  permission,
  startedAt: 1,
});

const cards: Record<string, ToolCard> = {
  a1: card("a1", "Read", "allowed"),
  d1: card("d1", "WebFetch", "denied"),
};

const WORKSPACE = "/srv/work/acme";

function render(over: Partial<Parameters<typeof PermissionDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    <PermissionDialog
      permission={child}
      index={0}
      total={1}
      workspaceConfigured={true}
      agents={agents}
      workspacePath={WORKSPACE}
      cards={cards}
      onDecide={() => {}}
      {...over}
    />,
  );
}

// ---- markup reading, independent of the component ---------------------------

interface Tag {
  name: string;
  attrs: string;
}

function tags(markup: string): Tag[] {
  return [...markup.matchAll(/<([a-zA-Z][\w-]*)((?:\s[^>]*?)?)\/?>/g)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: m[2],
  }));
}

/** What a browser puts in the Tab order, by the HTML rule and nothing else. */
const NATIVELY_FOCUSABLE = new Set(["button", "select", "textarea"]);

function focusableByHtml(tag: Tag): boolean {
  if (/\stabindex="-/.test(tag.attrs)) return false;
  if (tag.name === "a") return /\shref=/.test(tag.attrs);
  if (tag.name === "input") return !/\stype="hidden"/.test(tag.attrs) && !/\sdisabled/.test(tag.attrs);
  if (NATIVELY_FOCUSABLE.has(tag.name)) return !/\sdisabled/.test(tag.attrs);
  return /\stabindex="\d+"/.test(tag.attrs);
}

/** The component's own selector, applied to the same markup. Handles the shapes
 *  a focus-trap selector is written in: a tag name, `[attr="value"]`, or a tag
 *  with an attribute. Anything else throws rather than passing quietly. */
function matchesSelector(tag: Tag, selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((part) => {
      const m = /^([a-zA-Z][\w-]*)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(part);
      if (m === null) throw new Error(`this test cannot read the selector part "${part}"`);
      const [, name, attr, value] = m;
      if (name !== undefined && tag.name !== name.toLowerCase()) return false;
      if (attr === undefined) return name !== undefined;
      if (value === undefined) return new RegExp(`\\s${attr}(=|\\s|$)`).test(tag.attrs);
      return new RegExp(`\\s${attr}="${value}"`).test(tag.attrs);
    });
}

// ---- the criteria -----------------------------------------------------------

describe("the window is a window", () => {
  it("carries the dialog role and blocks the page behind it", () => {
    const markup = render();
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('class="modal-backdrop"');
  });

  it("answers with Deny or Allow and offers nothing else", () => {
    // Fix round 2026-09-24. The owner on the bar: "Das braucht man nicht."
    // "Later" existed only to fold the window into that bar, so it went with
    // it. The window stays until somebody answers.
    setLang("en");
    const buttons = [...render().matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(buttons).toEqual([dict["perm.deny"].en, dict["perm.allow"].en]);
  });

  it("has no set-aside control left in its source or its dictionary", () => {
    const src = stripComments(read("./PermissionDialog.tsx", import.meta.url));
    expect(src).not.toContain("onLater");
    expect(src).not.toContain("perm.later");
    for (const key of ["perm.later", "perm.laterAria", "gate.reopen"]) {
      expect(dict[key], key).toBeUndefined();
    }
  });
});

describe("a single line command is readable without reading JSON", () => {
  it("lifts a short command into a labelled block of its own", () => {
    setLang("en");
    const markup = render();
    expect(markup).toContain(dict["perm.command"].en);
    expect(markup).toContain("rm -rf build");
    // The JSON shape stays: the block is in ADDITION to it, never instead.
    expect(markup).toContain("&quot;command&quot;");
  });

  it("does not repeat a multi line command that the payload already lifts", () => {
    // The rule the file has always followed: a folded command reads as a
    // comment, so a multi-line command belongs in the payload's own block and
    // nowhere else. One copy, not two.
    expect(gateCommand("Bash", { command: "# keep the cache\nrm -rf build" })).toBeNull();
    expect(gateCommand("Bash", { command: "rm -rf build" })).toBe("rm -rf build");
  });

  it("has no command block for a call that is not a command", () => {
    expect(gateCommand("Write", { path: "/etc/hosts", content: "a" })).toBeNull();
    expect(render({ permission: { ...child, name: "Write", input: { path: "/etc/hosts" } } })).not.toContain(
      dict["perm.command"].en,
    );
  });
});

describe("the window names who asked and where it would land", () => {
  it("names the child, its parent and the task it was given", () => {
    setLang("en");
    const markup = render();
    // Each of the three is pinned in the LABELLED form the window renders.
    // A bare "main" was not enough: the recorded-decisions rows carry the same
    // word, so the assertion stayed green with the parent line removed.
    expect(markup).toContain(dict["perm.by"].en.replace("{id}", "sub-7"));
    expect(markup).toContain(dict["perm.parent"].en.replace("{id}", "main"));
    expect(markup).toContain(dict["perm.task"].en.replace("{task}", "tidy the build folder"));
  });

  it("says nothing about a parent when the main agent asks", () => {
    const markup = render({ permission: { ...child, agentId: "main" } });
    expect(markup).not.toContain(dict["perm.parent"].en.replace("{id}", "main"));
  });

  it("names the working directory, labelled", () => {
    setLang("en");
    const markup = render();
    expect(markup).toContain(dict["perm.cwd"].en);
    expect(markup).toContain(WORKSPACE);
  });

  it("leaves the directory line out when nothing announced one", () => {
    setLang("en");
    expect(render({ workspacePath: null })).not.toContain(dict["perm.cwd"].en);
  });
});

describe("earlier decisions travel with the window", () => {
  it("shows the recorded outcomes the bar shows", () => {
    setLang("en");
    const markup = render();
    expect(markup).toContain(dict["gate.recorded"].en);
    expect(markup).toContain("Read");
    expect(markup).toContain("WebFetch");
    expect(markup).toContain(dict["gate.histAllowed"].en);
    expect(markup).toContain(dict["gate.histDenied"].en);
  });

  it("draws no history block when nothing was decided yet", () => {
    setLang("en");
    expect(render({ cards: {} })).not.toContain(dict["gate.recorded"].en);
  });
});

describe("the focus trap covers every control on the window", () => {
  it("reaches as many nodes as the markup makes focusable", () => {
    const markup = render();
    const all = tags(markup);
    const byHtml = all.filter(focusableByHtml);
    const bySelector = all.filter((tag) => matchesSelector(tag, GATE_FOCUSABLE_SELECTOR));
    expect(byHtml.length).toBeGreaterThan(3);
    expect(bySelector.length).toBe(byHtml.length);
  });

  it("reaches the remember checkbox, and the persist checkbox beside it", () => {
    const markup = render();
    const checkboxes = tags(markup).filter((tag) => tag.name === "input");
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(matchesSelector(box, GATE_FOCUSABLE_SELECTOR)).toBe(true);
    }
  });
});

describe("deny stays the safe default", () => {
  it("puts the initial focus on Deny", () => {
    setLang("en");
    const markup = render();
    const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)</g)];
    const focused = buttons.find((m) => m[0].includes("autofocus"));
    expect(focused, "no button carries the initial focus").toBeDefined();
    expect(focused?.[1]).toBe(dict["perm.deny"].en);
  });

  it("gives the scrim no way to close the window", () => {
    // Source read, named as one: a click handler is not visible in markup.
    const src = stripComments(read("./PermissionDialog.tsx", import.meta.url));
    const open = src.slice(src.indexOf('className="modal-backdrop"'));
    const tag = open.slice(0, open.indexOf(">"));
    expect(tag).not.toContain("onClick");
    expect(tag).not.toContain("onMouseDown");
  });
});

describe("both languages", () => {
  const keys = ["perm.command", "perm.cwd", "perm.parent", "perm.task", "gate.waitingInChat"];

  it("every new key exists in German and in English", () => {
    for (const key of keys) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de, `${key}.de`).toBeTruthy();
      expect(dict[key].en, `${key}.en`).toBeTruthy();
    }
  });

  it("renders the German strings when the chrome is German", () => {
    setLang("de");
    const markup = render();
    expect(markup).toContain(dict["perm.cwd"].de);
    expect(markup).toContain(dict["perm.deny"].de);
    setLang("en");
  });
});

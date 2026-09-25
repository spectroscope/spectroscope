// Card 389: what the working folder row draws for each announcement. Rendered
// on React's server renderer (this suite has no DOM), so the markup is the
// row's first paint for a given frame; clicks go through the drive kit.
import { isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { dict, t, type Lang } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { initialState, reduce, type WorkspaceInfo } from "../state/reducer";
import { drive, type El } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { CHOOSER_OPTIONS, optionFor } from "../workspace/chooserMode";
import { WorkspaceChooser } from "./WorkspaceChooser";

afterEach(() => setLang("en"));

const LANGS: Lang[] = ["en", "de"];

function markup(workspace: WorkspaceInfo | null, lang: Lang = "en", canPick = true): string {
  setLang(lang);
  return renderToStaticMarkup(
    <WorkspaceChooser
      sendClient={() => true}
      onPickFolder={() => {}}
      workspace={workspace}
      canPick={canPick}
    />,
  );
}

/** Every `<button ...>` open tag, as a map of its attributes. */
function buttons(html: string): Record<string, string>[] {
  return [...html.matchAll(/<button([^>]*)>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? ""])),
  );
}

/** The text between a button's open tag and its close tag, per option. */
function optionText(html: string, option: string): string | null {
  const m = html.match(new RegExp(`<button[^>]*data-option="${option}"[^>]*>([^<]*)</button>`));
  return m === null ? null : m[1];
}

const checked = (html: string): string[] =>
  buttons(html)
    .filter((b) => b["aria-checked"] === "true")
    .map((b) => b["data-option"]);

/** A frame through the real reducer, shaped like the ones SessionConnection sends. */
const announce = (o: Record<string, unknown>): WorkspaceInfo | null =>
  reduce(initialState, { type: "workspace_info", ts: 1, ...o } as unknown as RunEvent).workspace;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Whether the folder carries the temporary marker span (English markup). */
const temporaryMark = (html: string): boolean =>
  new RegExp(`class="ws-chooser-new">[^<]*${t("en", "workspace.temporary")}<`).test(html);

/** The row's element tree for one announcement, outermost first. */
function treeOf(workspace: WorkspaceInfo | null, lang: Lang = "en", canPick = true): El[] {
  setLang(lang);
  return drive(
    <WorkspaceChooser
      sendClient={() => true}
      onPickFolder={() => {}}
      workspace={workspace}
      canPick={canPick}
    />,
    [WorkspaceChooser],
    [],
  );
}

/** The elements that carry `cls` among their classes. */
const byClass = (tree: El[], cls: string): El[] =>
  tree.filter((el) =>
    String(el.props.className ?? "")
      .split(/\s+/)
      .includes(cls),
  );

/** The one element that carries `cls`, or a failure naming how many did. */
function theOne(tree: El[], cls: string): El {
  const all = byClass(tree, cls);
  if (all.length !== 1) throw new Error(`expected one .${cls}, found ${all.length}`);
  return all[0];
}

/** The text a node renders, children and all. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n as ReactNode)).join("");
  if (isValidElement(node)) return textOf((node as El).props.children);
  return "";
}

/** Whether `child` is somewhere inside `parent`. */
function contains(parent: El, child: El): boolean {
  const walk = (n: ReactNode): boolean => {
    if (Array.isArray(n)) return n.some((c) => walk(c as ReactNode));
    if (!isValidElement(n)) return false;
    return n === child || walk((n as El).props.children);
  };
  return walk(parent.props.children);
}

/** The words the dictionary puts before and after the gone folder's name. */
function wordsAround(lang: Lang): [string, string] {
  const template = t(lang, "workspace.unavailable");
  const at = template.indexOf("{name}");
  if (at < 0) throw new Error(`workspace.unavailable (${lang}) names no {name}`);
  return [template.slice(0, at), template.slice(at + "{name}".length)];
}

describe("the empty state is a named entry (card 389, criterion 3)", () => {
  for (const lang of LANGS) {
    it(`draws the no-folder entry and marks it for a fresh chat with nothing configured (${lang})`, () => {
      const html = markup(announce({ resolved: false, mode: "random", configured: false }), lang);
      expect(optionText(html, "random")).toBe(t(lang, "workspace.opt.random"));
      expect(checked(html)).toEqual(["random"]);
      // No folder name and no path is claimed anywhere on the row.
      expect(html).not.toContain("ws-chooser-folder");
      expect(html).not.toMatch(/title="\//);
    });
  }

  it("reads Kein Ordner and No folder", () => {
    expect(dict["workspace.opt.random"]).toEqual({ de: "Kein Ordner", en: "No folder" });
  });

  it("draws the entry before any frame arrives, and marks nothing", () => {
    const html = markup(null);
    expect(optionText(html, "random")).toBe(t("en", "workspace.opt.random"));
    expect(checked(html)).toEqual([]);
  });
});

describe("a resumed session marks one option (card 288, criterion 2)", () => {
  it("marks the option for the recorded mode, on its key and its class", () => {
    const html = markup(
      announce({
        resolved: true,
        mode: "recorded",
        exists: true,
        sessionId: "s1",
        path: "/Users/you/particle",
        configured: true,
      }),
    );
    expect(checked(html)).toEqual([optionFor("recorded")]);
    const on = buttons(html).filter((b) => (b.class ?? "").split(" ").includes("ws-chooser-opt--on"));
    expect(on.map((b) => b["data-option"])).toEqual([optionFor("recorded")]);
    expect(html).toContain(">particle<");
  });
});

describe("a folder the server could not use says so (card 389, criterion 5)", () => {
  for (const lang of LANGS) {
    it(`names the folder that is gone and the folder in use (${lang})`, () => {
      const frame = announce({
        resolved: false,
        mode: "default",
        unavailable: "/Users/you/ForgeDemo",
        configured: true,
        path: "/Users/you/work",
        exists: true,
      });
      const html = markup(frame, lang);
      const gone = theOne(treeOf(frame, lang), "ws-chooser-gone");
      expect(textOf(gone)).toBe(t(lang, "workspace.unavailable", { name: "ForgeDemo" }));
      expect(html).toMatch(/class="ws-chooser-gone[^"]*" title="\/Users\/you\/ForgeDemo"/);
      expect(html).toMatch(/title="\/Users\/you\/work">work</);
    });
  }

  it("keeps the end of the sentence for a long folder name, and the path in the tooltip", () => {
    const long = "/Users/you/a-very-long-folder-name-that-keeps-going";
    const frame = announce({
      resolved: false,
      mode: "default",
      unavailable: long,
      configured: true,
      path: "/Users/you/work",
    });
    const gone = theOne(treeOf(frame), "ws-chooser-gone");
    expect(textOf(gone)).toBe(t("en", "workspace.unavailable", { name: "a-very-long-folder-name…" }));
    expect(markup(frame)).toContain(`title="${long}"`);
  });

  for (const lang of LANGS) {
    it(`puts the name in a span of its own and the dictionary's words in theirs (${lang})`, () => {
      // A width can shorten the name; it must not reach the words that say
      // the folder is gone (review 2026-09-24, measured at 390 px).
      const tree = treeOf(
        announce({
          resolved: false,
          mode: "default",
          unavailable: "/Users/you/ForgeDemo",
          configured: true,
          path: "/Users/you/work",
        }),
        lang,
        false,
      );
      const gone = theOne(tree, "ws-chooser-gone");
      const name = theOne(tree, "ws-chooser-gone-name");
      expect(contains(gone, name)).toBe(true);
      expect(textOf(name)).toBe("ForgeDemo");
      const words = byClass(tree, "ws-chooser-gone-words").map(textOf);
      expect(words).toEqual(wordsAround(lang).filter((w) => w !== ""));
      expect(words.length).toBeGreaterThan(0);
      expect(textOf(gone)).toBe(t(lang, "workspace.unavailable", { name: "ForgeDemo" }));
    });
  }

  it("says nothing about a gone folder when the frame names none", () => {
    const html = markup(
      announce({ resolved: false, mode: "default", configured: true, path: "/Users/you/work" }),
    );
    expect(html).not.toContain("ws-chooser-gone");
  });
});

describe("the folder has a line of its own on the row (card 389, review 2026-09-24)", () => {
  it("keeps that line with nothing in it when there is nothing to name", () => {
    const tree = treeOf(announce({ resolved: false, mode: "random", configured: false }));
    const where = theOne(tree, "ws-chooser-where");
    expect(textOf(where)).toBe("");
    expect(byClass(tree, "ws-chooser-folder")).toEqual([]);
  });

  it("carries the folder in use and the gone notice on that line", () => {
    const tree = treeOf(
      announce({
        resolved: false,
        mode: "default",
        unavailable: "/Users/you/ForgeDemo",
        configured: true,
        path: "/Users/you/work",
      }),
    );
    const where = theOne(tree, "ws-chooser-where");
    expect(contains(where, theOne(tree, "ws-chooser-folder"))).toBe(true);
    expect(contains(where, theOne(tree, "ws-chooser-gone"))).toBe(true);
  });

  it("sits on the row's line after the label and the options", () => {
    const tree = treeOf(announce({ resolved: false, mode: "default", configured: true, path: "/w" }));
    const row = theOne(tree, "ws-chooser");
    const line = theOne(tree, "ws-chooser-line");
    expect(contains(row, line)).toBe(true);
    const parts = ["ws-chooser-label", "ws-chooser-opts", "ws-chooser-where"].map((c) => theOne(tree, c));
    for (const part of parts) expect(contains(line, part)).toBe(true);
    expect(parts.map((p) => tree.indexOf(p))).toEqual(
      [...parts.map((p) => tree.indexOf(p))].sort((a, b) => a - b),
    );
  });
});

describe("the full path is the tooltip and the last segment is the text (card 389, criterion 6)", () => {
  const cases: [string, string][] = [
    ["/Users/you/code/spectro/particle_demo", "particle_demo"],
    ["/work", "work"],
    ["/Users/you/work/", "work"],
  ];
  for (const [path, name] of cases) {
    it(`prints ${name} for ${path}`, () => {
      const html = markup(
        announce({ resolved: false, mode: "default", configured: true, path, exists: true }),
      );
      expect(html).toMatch(new RegExp(`class="ws-chooser-folder[^"]*" title="${path}">${name}<`));
    });
  }

  it("names the folder a random run resolved to, and says it is temporary", () => {
    const html = markup(
      announce({
        resolved: true,
        mode: "random",
        exists: true,
        sessionId: "s-9",
        path: "/tmp/runs/s-9",
        configured: false,
      }),
      "en",
      false,
    );
    expect(html).toMatch(/class="ws-chooser-folder[^"]*" title="\/tmp\/runs\/s-9">s-9/);
    expect(temporaryMark(html)).toBe(true);
  });

  it("calls a configured folder nothing temporary", () => {
    const html = markup(
      announce({ resolved: false, mode: "default", configured: true, path: "/Users/you/work" }),
    );
    // The marker span, not the word: the no-folder hint says "temporary" too.
    expect(temporaryMark(html)).toBe(false);
    expect(html).toMatch(/title="\/Users\/you\/work">work</);
  });
});

describe("the row once the agent has run (owner call 1, default)", () => {
  for (const lang of LANGS) {
    it(`draws every option disabled with the reason as the tooltip (${lang})`, () => {
      const html = markup(
        announce({ resolved: true, mode: "default", configured: true, path: "/w" }),
        lang,
        false,
      );
      const all = buttons(html);
      expect(all).toHaveLength(CHOOSER_OPTIONS.length);
      for (const b of all) {
        expect(b.disabled, `${b["data-option"]} is not disabled`).toBe("");
        expect(b.title).toBe(escapeHtml(t(lang, "workspace.fixed")));
      }
      expect(html).toMatch(
        new RegExp(`class="ws-chooser"[^>]*title="${escapeHtml(t(lang, "workspace.fixed"))}"`),
      );
    });
  }

  it("draws no option disabled while the folder can still change", () => {
    const html = markup(announce({ resolved: false, mode: "default", configured: true, path: "/w" }));
    for (const b of buttons(html)) expect(b.disabled).toBeUndefined();
  });
});

describe("a new chat forgets the last chat's click", () => {
  // The row stays mounted in the composer across "New chat" from a chat that
  // had no prompt yet, and New chat resets the live state to no announcement
  // at all. A click remembered from the chat
  // before would go on marking an option the new chat's server never named.
  let setWorkspace: (w: WorkspaceInfo | null) => void = () => {};
  const configured = announce({ resolved: false, mode: "default", configured: true, path: "/w" });
  function Host(): ReactElement {
    const [ws, setWs] = useState<WorkspaceInfo | null>(configured);
    setWorkspace = setWs;
    return <WorkspaceChooser sendClient={() => true} onPickFolder={() => {}} workspace={ws} canPick={true} />;
  }
  const marked = (tree: El[]): unknown[] =>
    tree
      .filter((el) => el.type === "button" && el.props["aria-checked"] === true)
      .map((el) => el.props["data-option"]);
  const pressNoFolder = (tree: El[]): void =>
    tree.find((el) => el.type === "button" && el.props["data-option"] === "random")?.props.onClick?.();

  it("marks what the new announcement says, not the old click", () => {
    const tree = drive(
      <Host />,
      [Host, WorkspaceChooser],
      [pressNoFolder, () => setWorkspace(null), () => setWorkspace(configured)],
    );
    expect(marked(tree)).toEqual(["default"]);
  });

  it("keeps the click while the same chat re-announces", () => {
    const echo = announce({ resolved: false, mode: "set", configured: true, path: "/tmp/runs/s-1" });
    const tree = drive(<Host />, [Host, WorkspaceChooser], [pressNoFolder, () => setWorkspace(echo)]);
    expect(marked(tree)).toEqual(["random"]);
  });
});

describe("a click", () => {
  const sent: ClientMessage[] = [];
  let picks = 0;
  const row = (canPick: boolean) => (
    <WorkspaceChooser
      sendClient={(m) => {
        sent.push(m);
        return true;
      }}
      onPickFolder={() => {
        picks++;
      }}
      workspace={announce({ resolved: false, mode: "default", configured: true, path: "/w" })}
      canPick={canPick}
    />
  );
  const press =
    (option: string) =>
    (tree: El[]): void => {
      const b = tree.find((el) => el.type === "button" && el.props["data-option"] === option);
      if (b === undefined) throw new Error(`no button for ${option}`);
      b.props.onClick?.();
    };

  it("on the no-folder entry sends the random mode, and on choose folder opens the dialog", () => {
    sent.length = 0;
    picks = 0;
    const tree = drive(row(true), [WorkspaceChooser], [press("random"), press("set")]);
    expect(sent).toEqual([{ type: "set_workspace", mode: "random" }]);
    expect(picks).toBe(1);
    const on = tree.filter((el) => el.type === "button" && el.props["aria-checked"] === true);
    expect(on.map((el) => el.props["data-option"])).toEqual(["set"]);
  });

  it("sends nothing once the folder is fixed", () => {
    sent.length = 0;
    picks = 0;
    drive(row(false), [WorkspaceChooser], [press("random"), press("set")]);
    expect(sent).toEqual([]);
    expect(picks).toBe(0);
  });
});

const chooserSrc = read("./WorkspaceChooser.tsx", import.meta.url);

describe("every string goes through the dictionary (card 389, criterion 9)", () => {
  it("keeps no inline language ternary", () => {
    const code = stripComments(chooserSrc);
    expect(code).not.toMatch(/\bde\s*\?/);
    expect(code).not.toMatch(/===\s*"de"/);
  });

  it("has a German and an English label and hint for every option", () => {
    for (const o of CHOOSER_OPTIONS) {
      for (const key of [`workspace.opt.${o}`, `workspace.hint.${o}`]) {
        expect(dict[key]?.de, `${key}.de`).toBeTruthy();
        expect(dict[key]?.en, `${key}.en`).toBeTruthy();
      }
    }
  });

  it("resolves every key the row names", () => {
    const keys = [...stripComments(chooserSrc).matchAll(/"(workspace\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(dict[key], key).toBeDefined();
  });
});

describe("nothing spectroscope owns is offered by name (card 389, criterion 11)", () => {
  const resolver = read(
    "../../../spectro-core/src/main/java/dev/spectroscope/core/config/WorkspaceResolver.java",
    import.meta.url,
  );
  /** The temp parent and the fixed fallback folder, off the resolver's own source. */
  function ownedNames(): string[] {
    const temp = resolver.match(/AUTO_WORKSPACE_DIR\s*=\s*"([^"]+)"/)?.[1];
    const start = resolver.indexOf("public static Path defaultDir()");
    const body = start < 0 ? "" : resolver.slice(start, resolver.indexOf("}", start));
    const fallback = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]).find((s) => s !== "user.home");
    return [temp, fallback].filter((s): s is string => typeof s === "string" && s !== "");
  }

  it("reads both names off the resolver", () => {
    expect(ownedNames()).toHaveLength(2);
  });

  it("names neither in any row string, in either language", () => {
    const names = ownedNames();
    const rowKeys = Object.keys(dict).filter((k) => k.startsWith("workspace."));
    expect(rowKeys.length).toBeGreaterThan(0);
    for (const key of rowKeys) {
      for (const lang of LANGS) {
        for (const name of names) expect(dict[key][lang], `${key}.${lang}`).not.toContain(name);
      }
    }
    for (const name of names) expect(chooserSrc).not.toContain(name);
  });
});

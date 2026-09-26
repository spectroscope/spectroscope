// Card 410, loop wave H1c: an opened pack stays inside the Skills view at a
// phone width.
//
// Measured in installed Chrome at 390 x 844 on the integration head 3433562e
// (kanban/evidence/410/loop/h1c/before/probe.json). With superpowers opened on
// an empty home, the switches of four rows (dispatching-parallel-agents,
// finishing-a-development-branch, subagent-driven-development,
// verification-before-completion) ended past the view's right edge and the view
// scrolled sideways, 415 px of content in 379. The row's name kept its full
// width (`.skset-name { flex: none }`), so the switch was pushed out.
//
// Every 390 px reading with the view's scrollbar showing (content box 379 px)
// split three pack headers: matt-pocock, superpowers and ui-ux-pro-max kept
// the install button beside the count and put the remove button alone on the
// next line, while humanizer kept both buttons together. In the two readings
// where the content box was 390 px (light, list closed or humanizer open), all
// four headers kept both buttons together.
//
// This suite has no layout engine. It pins the markup and the declarations the
// after reading (kanban/evidence/410/loop/h1c/after/probe.json) was taken on.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CataloguePack } from "./SkillsMcpSettings";
import { packGroups } from "../state/skillPacks";
import type { CatalogueRow } from "../state/skillInstall";
import { blockOf, read } from "../testkit/source";

const css = read("../styles/surfaces.css", import.meta.url);

const row = (name: string, installed: boolean): CatalogueRow => ({
  id: `superpowers/${name}`,
  name,
  pack: "superpowers",
  description: `${name} does one thing.`,
  licence: "MIT",
  repo: "https://example.com/repo",
  commit: "0".repeat(40),
  files: 3,
  bytes: 1200,
  installed,
  root: installed ? "user" : null,
});

const [group] = packGroups([row("verification-before-completion", true), row("writing-plans", false)]);

const packHtml = (open: boolean): string =>
  renderToStaticMarkup(
    <CataloguePack
      group={group}
      lang="en"
      open={open}
      onToggle={() => {}}
      busy={false}
      pendingSet={null}
      installingId={null}
      removingId={null}
      refused={null}
      reload={() => {}}
    />,
  );

describe("an opened pack's row gives way in its name, not past the right edge", () => {
  it("lets the name of an opened pack's row shrink and wrap", () => {
    const name = blockOf(css, ".skset-pack-rows .skset-name");
    expect(name).toMatch(/flex:\s*0 1 auto/);
    expect(name).toMatch(/min-width:\s*0/);
    // A name with no hyphen has nowhere to break without this. Measured at
    // 390 px with one name replaced by a 30-letter word
    // (kanban/evidence/410/loop/h1c/after/nohyphen.json): with it the word
    // takes two lines inside its 158 px box; with overflow-wrap normal the
    // text runs 216 px, out of the box and over the pack chip.
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the pack chip of that row on one line", () => {
    expect(blockOf(css, ".skset-pack-rows .wsg-scope-tag")).toMatch(/flex:\s*none/);
  });

  it("leaves the unscoped name alone, so a pack header and the settings page's rows keep theirs whole", () => {
    expect(blockOf(css, ".skset-name")).toMatch(/flex:\s*none/);
  });

  it("the opened row carries switch, name, chip and description in that order (card 411)", () => {
    expect(packHtml(true)).toMatch(
      /<li class="skset-row"><button[^>]*role="switch"[^>]*>[\s\S]*?<\/button><span class="skset-name mono">verification-before-completion<\/span><span class="wsg-scope-tag">superpowers<\/span><span class="skset-desc"[^>]*>verification-before-completion does one thing.<\/span><\/li>/,
    );
  });
});

describe("a pack header keeps its two set buttons together", () => {
  it("puts both set buttons in one group after the toggle", () => {
    const head = /<div class="skset-pack-head">([\s\S]*?)<\/div>/.exec(packHtml(false))?.[1] ?? "";
    expect(head).toMatch(
      /^<button[^>]*class="skset-pack-toggle"[^>]*>[\s\S]*?<\/button><span class="skset-pack-sets"><button[^>]*class="skset-install skset-pack-install"[^>]*>[^<]*<\/button><button[^>]*class="skset-del skset-pack-remove"[^>]*>[^<]*<\/button><\/span>$/,
    );
  });

  it("the group wraps as one piece and stays at the right edge", () => {
    const sets = blockOf(css, ".skset-pack-sets");
    expect(sets).toMatch(/display:\s*flex/);
    expect(sets).toMatch(/flex:\s*none/);
    expect(sets).toMatch(/margin-left:\s*auto/);
    expect(blockOf(css, ".skset-pack-head")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("caret, name and count keep their width inside the toggle, so they share one line", () => {
    expect(blockOf(css, ".skset-pack-caret")).toMatch(/flex:\s*none/);
    expect(blockOf(css, ".skset-pack-count")).toMatch(/flex:\s*none/);
  });
});

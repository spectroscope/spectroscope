// Card 558, criteria 2 and 3 in the composer: the slash picker lists the
// session's own items (session_items) with their namespaced names and the
// source as a small label, skills and commands alike, and no agent. A changed
// pick takes the old playbook's items out once the new list arrives. Without
// a list yet it falls back to the installed skills (GET /api/skills).
//
// No DOM in this suite (house rule): the markup is rendered statically.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useSlashPicker } from "./SlashPicker";
import { __resetSkillList, loadSkills } from "../state/skillList";
import { parseSessionItems, type SessionItems } from "../state/sessionItems";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";

const PICKED = parseSessionItems({
  playbook: { dir: "/pb/spectro", id: "spectro", name: "Team X" },
  items: [
    {
      kind: "agent",
      name: "reviewer",
      plain: "reviewer",
      source: "playbook",
      namespace: "spectro",
      description: "Reviews diffs",
    },
    {
      kind: "command",
      name: "ship",
      plain: "ship",
      source: "playbook",
      namespace: "spectro",
      description: "Ship it",
    },
    {
      kind: "skill",
      name: "spectro:brainstorming",
      plain: "brainstorming",
      source: "playbook",
      namespace: "spectro",
      description: "Team brainstorming",
    },
    {
      kind: "skill",
      name: "lint",
      plain: "lint",
      source: "workspace",
      namespace: "workspace",
      description: "Lint it",
    },
    {
      kind: "skill",
      name: "user:brainstorming",
      plain: "brainstorming",
      source: "user",
      namespace: "user",
      description: "My brainstorming",
    },
  ],
}) as SessionItems;

const NONE = parseSessionItems({
  playbook: null,
  items: [
    {
      kind: "skill",
      name: "brainstorming",
      plain: "brainstorming",
      source: "user",
      namespace: "user",
      description: "My brainstorming",
    },
    {
      kind: "skill",
      name: "lint",
      plain: "lint",
      source: "workspace",
      namespace: "workspace",
      description: "Lint it",
    },
  ],
}) as SessionItems;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  setLang("en");
});

function Picker({ draft, items }: { draft: string; items: SessionItems | null }) {
  const slash = useSlashPicker(draft, draft.length, true, () => undefined, undefined, items);
  return <div>{slash.node}</div>;
}

const render = (draft: string, items: SessionItems | null): string =>
  renderToStaticMarkup(<Picker draft={draft} items={items} />);

/** The text of each row's name, in order. */
const rowNames = (html: string): string[] =>
  [...html.matchAll(/<span class="slash-name mono">([^<]*)<\/span>/g)].map((m) => m[1]);

describe("the slash picker on the session's items", () => {
  it("lists the session's skills and commands by their effective names, each with its source", () => {
    const html = render("/", PICKED);

    expect(rowNames(html)).toEqual(["lint", "ship", "spectro:brainstorming", "user:brainstorming"]);
    expect(html).not.toContain("reviewer");
    expect(html).toContain(`data-source="playbook">Team X</span>`);
    expect(html).toContain(`data-source="workspace">${dict["slash.src.workspace"].en}</span>`);
    expect(html).toContain(`data-source="user">${dict["slash.src.user"].en}</span>`);
    expect(html).toContain(`data-kind="command">${dict["slash.kind.command"].en}</span>`);
  });

  it("finds a doubled name under every namespace when the plain name is typed", () => {
    expect(rowNames(render("/brainstorming", PICKED))).toEqual([
      "spectro:brainstorming",
      "user:brainstorming",
    ]);
  });

  it("drops the old playbook's items once the list for the new pick arrives (criterion 3)", () => {
    const before = rowNames(render("/", PICKED));
    const after = rowNames(render("/", NONE));

    expect(before).toContain("spectro:brainstorming");
    expect(after).toEqual(["brainstorming", "lint"]);
    expect(after).not.toContain("ship");
    expect(render("/", NONE)).not.toContain('data-source="playbook"');
  });

  it("falls back to the installed skills while the session has sent no list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            skills: [
              {
                name: "verification",
                folder: "verification",
                pack: null,
                description: "Check",
                disabled: false,
              },
            ],
          }),
      } as unknown as Response),
    );
    loadSkills();
    await flush();

    const html = render("/", null);
    expect(rowNames(html)).toEqual(["verification"]);
    expect(html).not.toContain("data-source");
  });
});

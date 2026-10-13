// Card 558, integrator decision 7b: the Skills and Commands page has a section
// "This session", the session's items by kind and source, read only, beside
// the installed-skills manager and the chat commands.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionItemsSection } from "./SessionItemsSection";
import { parseSessionItems, type SessionItems } from "../state/sessionItems";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { read } from "../testkit/source";

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
      name: "user:brainstorming",
      plain: "brainstorming",
      source: "user",
      namespace: "user",
      description: "My brainstorming",
    },
  ],
}) as SessionItems;

afterEach(() => setLang("en"));

describe("This session on the Skills and Commands page", () => {
  it("lists the session's items by kind, each with its source, and names the picked playbook", () => {
    const html = renderToStaticMarkup(<SessionItemsSection items={PICKED} />);

    expect(html).toContain(dict["skv.session"].en);
    expect(html).toContain(dict["skv.kind.skill"].en);
    expect(html).toContain(dict["skv.kind.command"].en);
    expect(html).toContain(dict["skv.kind.agent"].en);
    expect(html).toContain('data-item="spectro:brainstorming"');
    expect(html).toContain('data-item="user:brainstorming"');
    expect(html).toContain('data-item="reviewer"');
    expect(html).toContain('data-source="playbook">Team X</span>');
    expect(html).toContain(`data-source="user">${dict["slash.src.user"].en}</span>`);
    expect(html.indexOf(dict["skv.kind.skill"].en)).toBeLessThan(html.indexOf(dict["skv.kind.agent"].en));
    expect(html).not.toContain("<button");
  });

  it("says when the session in view has sent no list", () => {
    const html = renderToStaticMarkup(<SessionItemsSection items={null} />);
    expect(html).toContain(dict["skv.sessionNone"].en);
  });

  it("stands on the page beside the manager and the chat commands", () => {
    const pane = read("./SkillsPane.tsx", import.meta.url);
    expect(pane).toContain("<SessionItemsSection");
    expect(pane.indexOf("<SkillsSettings")).toBeLessThan(pane.indexOf("<SessionItemsSection"));
    expect(pane.indexOf("<SessionItemsSection")).toBeLessThan(pane.indexOf("<ChatCommandsSection"));
  });
});

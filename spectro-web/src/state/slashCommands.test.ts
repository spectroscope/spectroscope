import { describe, expect, it } from "vitest";
import { invocationFor, matchSkills, slashQuery, type SkillOption } from "./slashCommands";

const skill = (name: string, over: Partial<SkillOption> = {}): SkillOption => ({
  name,
  folder: name.includes(":") ? name.slice(name.indexOf(":") + 1) : name,
  pack: name.includes(":") ? name.slice(0, name.indexOf(":")) : null,
  description: `what ${name} is for`,
  disabled: false,
  ...over,
});

const LIBRARY: SkillOption[] = [
  skill("verification"),
  skill("superpowers:brainstorming"),
  skill("superpowers:writing-plans"),
  skill("humanizer:humanizer"),
  skill("matt-pocock:code-review"),
];

describe("when the composer is spelling a command", () => {
  it("reads the query out of a draft that starts with a slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/hum")).toBe("hum");
    expect(slashQuery("/superpowers:brain")).toBe("superpowers:brain");
  });

  it("says nothing for a slash that is not at the start", () => {
    // Hijacking a mid-sentence slash would make "and/or" impossible to type,
    // which is the reason the rule is where it is rather than what it is.
    expect(slashQuery("and/or")).toBeNull();
    expect(slashQuery("write and/or read")).toBeNull();
    expect(slashQuery(" /hum")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });

  it("stops being a command the moment the draft becomes a sentence", () => {
    // "/humanize this paragraph" is a person writing, not a person picking.
    expect(slashQuery("/hum this")).toBeNull();
    expect(slashQuery("/ ")).toBeNull();
    expect(slashQuery("/hum\nmore")).toBeNull();
  });
});

describe("which skills a query offers", () => {
  it("offers everything for a bare slash", () => {
    expect(matchSkills("", LIBRARY).map((s) => s.name)).toEqual([
      "humanizer:humanizer",
      "matt-pocock:code-review",
      "superpowers:brainstorming",
      "superpowers:writing-plans",
      "verification",
    ]);
  });

  it("finds a packed skill by the part a reader actually remembers", () => {
    // Nobody types the pack first. "brain" has to reach
    // superpowers:brainstorming or the namespace has made the feature worse.
    expect(matchSkills("brain", LIBRARY).map((s) => s.name)).toEqual(["superpowers:brainstorming"]);
    expect(matchSkills("code", LIBRARY).map((s) => s.name)).toEqual(["matt-pocock:code-review"]);
  });

  it("finds it by the pack too, for somebody who installed the pack", () => {
    expect(matchSkills("superpowers", LIBRARY).map((s) => s.name)).toEqual([
      "superpowers:brainstorming",
      "superpowers:writing-plans",
    ]);
  });

  it("puts what a name STARTS with above what it merely contains", () => {
    const library = [skill("review-notes"), skill("matt-pocock:code-review")];
    expect(matchSkills("review", library).map((s) => s.name)).toEqual([
      "review-notes",
      "matt-pocock:code-review",
    ]);
  });

  it("ignores case, because nobody shifts while completing", () => {
    expect(matchSkills("BRAIN", LIBRARY).map((s) => s.name)).toEqual(["superpowers:brainstorming"]);
  });

  it("leaves a disabled skill out entirely", () => {
    // The list is what the agent can currently do. Offering something the
    // system prompt was never told about is a lie the reader cannot see.
    const library = [skill("verification"), skill("humanizer:humanizer", { disabled: true })];
    expect(matchSkills("", library).map((s) => s.name)).toEqual(["verification"]);
    expect(matchSkills("human", library)).toEqual([]);
  });

  it("offers nothing rather than everything when nothing matches", () => {
    expect(matchSkills("zzz", LIBRARY)).toEqual([]);
  });
});

describe("what picking one puts in the composer", () => {
  it("writes a sentence the reader can read and edit", () => {
    // A skill is instructions in the system prompt, not a callable, so this is
    // a message asking for it by name. Visible and editable beats a hidden
    // instruction the sender never sees.
    const text = invocationFor(skill("humanizer:humanizer"), "en");
    expect(text).toContain("humanizer:humanizer");
    expect(text.startsWith("/")).toBe(false);
    expect(text.endsWith(" ")).toBe(true); // the cursor lands after it, mid-sentence
  });

  it("names the skill exactly as the agent knows it, namespace and all", () => {
    expect(invocationFor(skill("superpowers:brainstorming"), "en")).toContain("superpowers:brainstorming");
    expect(invocationFor(skill("verification"), "en")).toContain("verification");
  });

  it("speaks the reader's language", () => {
    expect(invocationFor(skill("verification"), "de")).not.toBe(invocationFor(skill("verification"), "en"));
  });
});

import { describe, expect, it } from "vitest";
import { matchSkills, slashQueryAt, tokenInsert, type SkillOption } from "./slashCommands";

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

describe("where the caret is spelling a command (card 247: anywhere in the text)", () => {
  it("reads the query out of a token being typed at the caret", () => {
    expect(slashQueryAt("/", 1)).toEqual({ query: "", start: 0 });
    expect(slashQueryAt("/hum", 4)).toEqual({ query: "hum", start: 0 });
    expect(slashQueryAt("review /wri", 11)).toEqual({ query: "wri", start: 7 });
    expect(slashQueryAt("a (/hum", 7)).toEqual({ query: "hum", start: 3 });
    expect(slashQueryAt("go /superpowers:brain", 21)).toEqual({ query: "superpowers:brain", start: 3 });
  });

  it("says nothing for a slash glued to a word — and/or stays typable", () => {
    expect(slashQueryAt("and/or", 6)).toBeNull();
    expect(slashQueryAt("3/4", 3)).toBeNull();
    expect(slashQueryAt("look at /tmp/x", 14)).toBeNull();
  });

  it("stops offering once the caret has left the token", () => {
    expect(slashQueryAt("/hum this", 9)).toBeNull();
    expect(slashQueryAt("go /plan now", 12)).toBeNull();
    expect(slashQueryAt("", 0)).toBeNull();
    expect(slashQueryAt("hello", 5)).toBeNull();
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

describe("what picking one puts in the composer (card 247: a token, in place)", () => {
  it("splices the token over the query, slash kept, a space after", () => {
    const picked = tokenInsert(
      "review /wri and ship",
      { query: "wri", start: 7 },
      11,
      skill("superpowers:writing-plans"),
    );
    expect(picked.text).toBe("review /superpowers:writing-plans and ship");
    expect(picked.caret).toBe("review /superpowers:writing-plans ".length);
  });

  it("completes a bare slash at the end of a sentence", () => {
    const picked = tokenInsert("first /", { query: "", start: 6 }, 7, skill("verification"));
    expect(picked.text).toBe("first /verification ");
    expect(picked.caret).toBe(picked.text.length);
  });

  it("names the skill exactly as the agent knows it, namespace and all", () => {
    const picked = tokenInsert("/b", { query: "b", start: 0 }, 2, skill("superpowers:brainstorming"));
    expect(picked.text).toBe("/superpowers:brainstorming ");
  });
});

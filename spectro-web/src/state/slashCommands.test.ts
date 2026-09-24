import { describe, expect, it } from "vitest";
import {
  CONTAINS,
  EXACT_FOLDER,
  EXACT_NAME,
  STARTS,
  exactSpellings,
  matchSkills,
  rankOf,
  slashQueryAt,
  tokenInsert,
  type SkillOption,
} from "./slashCommands";

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

  it("puts the name typed in FULL above a longer name that starts with it", () => {
    // Measured 2026-09-18 on the installed skills: all three of these return
    // the wrong first row today, and Enter inserts a skill nobody typed.
    const tdd = [skill("superpowers:test-driven-development"), skill("test-driven-development")];
    expect(matchSkills("test-driven-development", tdd).map((s) => s.name)).toEqual([
      "test-driven-development",
      "superpowers:test-driven-development",
    ]);

    const plans = [skill("superpowers:writing-plans"), skill("writing-plans")];
    expect(matchSkills("writing-plans", plans).map((s) => s.name)).toEqual([
      "writing-plans",
      "superpowers:writing-plans",
    ]);

    // Not a namespace collision: the packed skill wins the STARTS tie on
    // localeCompare, so a set built from bare-name collisions alone misses it.
    const verify = [skill("superpowers:verification-before-completion"), skill("verification")];
    expect(matchSkills("verification", verify).map((s) => s.name)).toEqual([
      "verification",
      "superpowers:verification-before-completion",
    ]);
  });

  it("puts an exact FOLDER above a name that merely starts with the query", () => {
    // The folder earns a tier of its own, below the full name: typing the half
    // a reader remembers still beats a longer neighbour.
    const library = [skill("aaa:review-notes-extra"), skill("zzz:review-notes")];
    expect(matchSkills("review-notes", library).map((s) => s.name)).toEqual([
      "zzz:review-notes",
      "aaa:review-notes-extra",
    ]);
  });

  it("offers a qualified name once, although both roots send it", () => {
    // SkillsController sends one row per root and nobody between dedupes
    // (SkillsController.java:195-204, skillList.ts:49-60), so `verification`
    // arrives twice. The loader's rule is that the later root wins
    // (SkillLibrary.java:120), and the picker follows it.
    const library = [
      skill("verification", { description: "the user root copy" }),
      skill("verification", { description: "the project root copy" }),
    ];
    const hits = matchSkills("verification", library);
    expect(hits.map((s) => s.name)).toEqual(["verification"]);
    expect(hits[0].description).toBe("the project root copy");
  });

  it("keeps the copy the loader keeps, whichever root carries the .disabled marker", () => {
    // loadSkill returns before it writes when the folder carries .disabled
    // (SkillLibrary.java:169-175, the only writer to byName at :175), so a
    // disabled copy never overwrites a live one. A skill live in the user root
    // and disabled in the project root is therefore LIVE for the agent, and a
    // picker that dropped it would hide a skill the agent can still call.
    const laterDisabled = [
      skill("verification", { description: "the user root copy" }),
      skill("verification", { description: "the project root copy", disabled: true }),
    ];
    const kept = matchSkills("verification", laterDisabled);
    expect(kept.map((s) => s.name)).toEqual(["verification"]);
    expect(kept[0].description).toBe("the user root copy");

    // The other direction, so a fix cannot simply drop the later row: when the
    // project copy is the live one, the later root still wins.
    const earlierDisabled = [
      skill("verification", { description: "the user root copy", disabled: true }),
      skill("verification", { description: "the project root copy" }),
    ];
    const later = matchSkills("verification", earlierDisabled);
    expect(later.map((s) => s.name)).toEqual(["verification"]);
    expect(later[0].description).toBe("the project root copy");

    // Both roots off means the agent cannot call it, so neither may the reader.
    const bothDisabled = laterDisabled.map((s) => ({ ...s, disabled: true }));
    expect(matchSkills("verification", bothDisabled)).toEqual([]);
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

describe("which spellings earn an exact tier (derived from the source, not retyped)", () => {
  const PACKED = skill("superpowers:writing-plans");
  const TOP = skill("verification");

  it("gives every exported exact spelling its own tier, all of them above STARTS", () => {
    for (const s of [PACKED, TOP]) {
      const spellings = exactSpellings(s);
      expect(spellings.length).toBeGreaterThan(0);
      spellings.forEach((spelling, tier) => {
        // A top-level skill spells its name and its folder the same way, and
        // rankOf returns on the first hit, so the rank an exact query wins is
        // the FIRST position that spelling holds, not every position it holds.
        const firstTier = spellings.findIndex((o) => o.toLowerCase() === spelling.toLowerCase());
        expect(rankOf(spelling.toLowerCase(), s), `${s.name} spelled "${spelling}"`).toBe(firstTier);
        // The derivation. A spelling added to the function without a tier of
        // its own lands on STARTS or below and this is what says so.
        expect(tier, `tier for "${spelling}"`).toBeLessThan(STARTS);
      });
    }
    expect([EXACT_NAME, EXACT_FOLDER]).toEqual([0, 1]);
  });

  it("gives the PACK no exact tier, on purpose", () => {
    // Decision 2: an exact tier on the pack would put seven rows on the top
    // rank at once for `ui-ux-pro-max`, which decides nothing.
    expect(rankOf("superpowers", PACKED)).toBe(STARTS);
    expect(rankOf("plans", PACKED)).toBe(CONTAINS);
    expect(rankOf("zzz", PACKED)).toBeNull();
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
